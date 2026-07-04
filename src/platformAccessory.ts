import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PropertyChange } from './echonet/client.js';
import { createColourTemperatureCurve, miredToKelvin, type ColourTemperatureCurveImpl } from './echonet/colorTemperature.js';
import { MANUFACTURERS } from './echonet/manufacturers.js';
import type { AccessoryContext, EchonetLightPlatform } from './platform.js';
import {
  EDT_OFF,
  EDT_ON,
  EPC,
  LEVEL_MAX,
  UNREACHABLE_PROBE_THRESHOLD,
  UPDATE_SETTLE_MS,
} from './settings.js';

/**
 * Brightness and colour temperature are both backed by the single ILLUMINANCE_LEVEL property, so a
 * slider drag fires a burst of onSet calls. We coalesce them into one write after the drag settles,
 * and ignore device updates for the UPDATE_SETTLE_MS window afterwards so they don't yank the slider.
 */
const LEVEL_WRITE_DEBOUNCE_MS = 250;

/** Which inbound path delivered a device update — for log attribution only. */
type UpdateSource = 'poll' | 'notify';

/** Origin prefix for directional state-sync log lines (`{actor} -> {device} …`). */
const ACTOR = {
  HOMEBRIDGE: 'Homebridge',
  ECHONET: 'ECHONET',
} as const;

/** A single-byte level EDT (0x00–0x64) → 0–100. */
function edtToLevel(edt: string): number {
  return Math.min(LEVEL_MAX, parseInt(edt.slice(0, 2), 16) || 0);
}

/** 0–100 → single-byte level EDT (0x00–0x64). */
function levelToEdt(level: number): string {
  return Math.round(Math.min(LEVEL_MAX, Math.max(0, level))).toString(16).padStart(2, '0');
}

/** Decode an ASCII-in-hex EDT (e.g. product code, production number) to a printable string. */
function decodeAscii(edt: string | undefined): string {
  if (!edt) {
    return '';
  }
  let out = '';
  for (let i = 0; i + 1 < edt.length; i += 2) {
    const code = parseInt(edt.slice(i, i + 2), 16);
    if (code >= 0x20 && code < 0x7f) {
      out += String.fromCharCode(code);
    }
  }
  return out.trim();
}

/**
 * Production date EPC 0x8E (4 bytes): YYYY MM DD 00 in BCD.
 * Combined with production number (0x8D) to form a human-readable firmware revision.
 */
function decodeFirmwareRevision(productionNumber: string | undefined, productionDate: string | undefined): string | undefined {
  const parts: string[] = [];

  if (productionNumber) {
    const ascii = decodeAscii(productionNumber);
    if (ascii) {
      parts.push(ascii);
    }
  }

  if (productionDate && productionDate.length >= 8) {
    const year = productionDate.slice(0, 4);
    const month = productionDate.slice(4, 6);
    const day = productionDate.slice(6, 8);
    parts.push(`${year}-${month}-${day}`);
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Handler for a single ECHONET Lite lighting device object.
 *
 * Capability is detected from the device's property maps:
 *   - dimmable (brightness EPC 0xB0 present) → Lightbulb with On + Brightness;
 *   - on/off only → Switch (so the user can present it as a Light or Fan in Apple Home).
 */
export class EchonetLightAccessory {
  private readonly ctx: AccessoryContext;
  private readonly service: Service;
  private readonly isDimmable: boolean;
  private readonly hasColorTemperature: boolean;
  private readonly ctCurve: ColourTemperatureCurveImpl;

  /** Debounce state for coalescing brightness/colour-temperature writes (see module header). */
  private pendingLevel?: number;
  private levelWriteTimer?: ReturnType<typeof setTimeout>;
  private suppressLevelUntil = 0;
  private suppressOnUntil = 0;

  /**
   * Reachability tracking. `reachable` mirrors what HomeKit currently shows; it flips to false only
   * after {@link UNREACHABLE_PROBE_THRESHOLD} consecutive liveness probes go unanswered, and back to
   * true on the first successful probe or inbound frame. See {@link probe} / {@link registerHit}.
   */
  private reachable = true;
  private consecutiveMisses = 0;

  /** True while a level write is debouncing or its update-suppression window is still open. */
  private get levelWriteInFlight(): boolean {
    return this.levelWriteTimer !== undefined || Date.now() < this.suppressLevelUntil;
  }

  constructor(
    private readonly platform: EchonetLightPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.ctx = accessory.context.device as AccessoryContext;
    this.ctCurve = createColourTemperatureCurve();
    const { ip, eoj } = this.ctx;
    const client = this.platform.client;

    this.setAccessoryInformation();

    this.isDimmable =
      client.supportsProperty(ip, eoj, EPC.ILLUMINANCE_LEVEL) ||
      client.supportsProperty(ip, eoj, EPC.MAX_SPECIFIABLE_ILLUMINANCE_LEVEL);
    // Colour temperature is derived from brightness, so it only applies to dimmable lights.
    this.hasColorTemperature = this.isDimmable && this.ctx.synchroColourTone;

    const { Service, Characteristic } = this.platform;

    if (this.isDimmable) {
      this.service = this.accessory.getService(Service.Lightbulb)
        ?? this.accessory.addService(Service.Lightbulb);
      this.removeService(Service.Switch);
    } else {
      this.service = this.accessory.getService(Service.Switch)
        ?? this.accessory.addService(Service.Switch);
      this.removeService(Service.Lightbulb);
    }

    this.service.setCharacteristic(Characteristic.Name, this.accessory.displayName);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    if (this.isDimmable) {
      this.service.getCharacteristic(Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    }

    if (this.hasColorTemperature) {
      this.service.getCharacteristic(Characteristic.ColorTemperature)
        .updateValue(this.ctCurve.miredMin)
        .setProps({ minValue: this.ctCurve.miredMin, maxValue: this.ctCurve.miredMax })
        .onGet(this.getColorTemperature.bind(this))
        .onSet(this.setColorTemperature.bind(this));

      // NB: we deliberately do NOT attach an AdaptiveLightingController. Colour temperature is a
      // derived view of the single ILLUMINANCE_LEVEL value, so it cannot be controlled independently
      // of brightness. With Adaptive Lighting attached, our derived CT sync (syncColorTemperature) is
      // interpreted as a manual CT override and reconciled back as brightness writes, which fight the
      // brightness/CT sliders into an oscillating feedback loop. Without it, the derived CT update is a
      // plain background value notification, and HomeKit can still set CT directly (driving brightness).
    } else if (this.service.testCharacteristic(Characteristic.ColorTemperature)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.ColorTemperature));
    }
  }

  private setAccessoryInformation() {
    const { ip, eoj } = this.ctx;
    const client = this.platform.client;
    const { Service, Characteristic } = this.platform;

    const manufacturerCode = client.getCached(ip, eoj, EPC.MANUFACTURER_CODE);
    const productCode = decodeAscii(client.getCached(ip, eoj, EPC.PRODUCT_CODE));
    const serial = decodeAscii(client.getCached(ip, eoj, EPC.PRODUCTION_NUMBER));

    const manufacturerName = manufacturerCode
      ? (MANUFACTURERS[manufacturerCode.toUpperCase().padStart(6, '0')] ?? `0x${manufacturerCode}`)
      : 'Unknown';

    const info = this.accessory.getService(Service.AccessoryInformation)!;
    info.setCharacteristic(Characteristic.Manufacturer, manufacturerName);
    info.setCharacteristic(Characteristic.Model, productCode || `ECHONET ${eoj.slice(0, 4)}`);
    info.setCharacteristic(Characteristic.SerialNumber, serial || this.ctx.identificationNumber);
    const firmware = decodeFirmwareRevision(
      client.getCached(ip, eoj, EPC.PRODUCTION_NUMBER),
      client.getCached(ip, eoj, EPC.PRODUCTION_DATE),
    );
    if (firmware) {
      info.setCharacteristic(Characteristic.FirmwareRevision, firmware);
    }
  }

  private removeService(type: typeof this.platform.Service.Switch | typeof this.platform.Service.Lightbulb) {
    const existing = this.accessory.getService(type);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }

  /** Fetch current device state and push it to HomeKit — used at startup and on periodic polls. */
  async refreshState(): Promise<void> {
    const name = this.accessory.displayName;
    const source: UpdateSource = 'poll';

    this.platform.log.debug(`${ACTOR.HOMEBRIDGE} [${source}] -> ${name} reading device state`);

    // OPERATION_STATUS (0x80) is the liveness signal — mandatory on every lighting class — so it
    // drives the reachability accounting. A silent device skips value application entirely.
    const statusEdt = await this.probe(EPC.OPERATION_STATUS);
    if (statusEdt === undefined) {
      this.platform.log.debug(`${ACTOR.ECHONET} [${source}] -> ${name} no response for OPERATION_STATUS`);
      return;
    }
    const on = statusEdt.toLowerCase() === EDT_ON;
    if (this.applyOn(on, source)) {
      this.platform.log.debug(`${ACTOR.ECHONET} [${source}] -> ${name} state set to ${on ? 'ON' : 'OFF'}`);
    }

    if (this.isDimmable) {
      // Brightness is a value sync only; the status probe above already settled reachability.
      const levelEdt = await this.probe(EPC.ILLUMINANCE_LEVEL, false);
      if (levelEdt !== undefined) {
        const level = edtToLevel(levelEdt);
        if (this.applyLevel(level, source)) {
          this.platform.log.debug(`${ACTOR.ECHONET} [${source}] -> ${name} brightness set to ${level}%`);
        }
      } else {
        this.platform.log.debug(`${ACTOR.ECHONET} [${source}] -> ${name} no response for ILLUMINANCE_LEVEL`);
      }
    }
  }

  /** Route a live property change from the network to the relevant HomeKit characteristic. */
  handleChange(change: PropertyChange) {
    if (change.ip !== this.ctx.ip || change.eoj.toLowerCase() !== this.ctx.eoj.toLowerCase()) {
      return;
    }
    // An inbound frame proves the device is alive — clears a stale Not Responding immediately.
    this.registerHit();
    const name = this.accessory.displayName;
    const source: UpdateSource = 'notify';
    switch (change.epc) {
    case EPC.OPERATION_STATUS: {
      const on = change.edt.toLowerCase() === EDT_ON;
      if (this.applyOn(on, source)) {
        this.platform.log.info(`${ACTOR.ECHONET} [${source}] -> ${name} state set to ${on ? 'ON' : 'OFF'}`);
      }
      break;
    }
    case EPC.ILLUMINANCE_LEVEL:
      if (this.isDimmable) {
        const level = edtToLevel(change.edt);
        if (this.applyLevel(level, source)) {
          this.platform.log.info(`${ACTOR.ECHONET} [${source}] -> ${name} brightness set to ${level}%`);
        }
      }
      break;
    }
  }

  /** Keep the derived ColorTemperature characteristic in step with the current brightness. */
  private syncColorTemperature(level: number) {
    if (this.hasColorTemperature) {
      this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.ctCurve.percentToMired(level));
    }
  }

  /**
   * Push a device-reported on/off state to HomeKit's On characteristic, returning whether it was
   * applied. Skips while our own write is still settling (suppressOnUntil) or the value is unchanged.
   */
  private applyOn(on: boolean, source: UpdateSource): boolean {
    const { Characteristic } = this.platform;
    const name = this.accessory.displayName;
    if (Date.now() < this.suppressOnUntil) {
      this.platform.log.debug(`${ACTOR.ECHONET} [${source}] -> ${name} skipping OPERATION_STATUS update (recent write): ${on ? 'ON' : 'OFF'}`);
      return false;
    }
    if (on === this.service.getCharacteristic(Characteristic.On).value) {
      return false;
    }
    this.service.updateCharacteristic(Characteristic.On, on);
    return true;
  }

  /**
   * Push a device-reported level to HomeKit's Brightness (and derived ColorTemperature), returning
   * whether it was applied. Skips when the user's own write is still in flight, when the equivalent
   * value is already set, or when the light is off — a powered-off device reports level 0, which we
   * ignore so HomeKit retains the previous brightness to restore on power-on. `source` only labels
   * the suppression log line.
   */
  private applyLevel(level: number, source: UpdateSource): boolean {
    const { Characteristic } = this.platform;
    const name = this.accessory.displayName;
    const isOff = !this.service.getCharacteristic(Characteristic.On).value;
    if (this.levelWriteInFlight || isOff) {
      const reason = this.levelWriteInFlight ? 'write in progress' : 'device off';
      this.platform.log.debug(
        `${ACTOR.ECHONET} [${source}] -> ${name} skipping ILLUMINANCE_LEVEL update (${reason}): level=${level}%`,
      );
      return false;
    }
    const currentLevel = this.service.getCharacteristic(Characteristic.Brightness).value;
    if (level === currentLevel) {
      return false;
    }
    this.service.updateCharacteristic(Characteristic.Brightness, level);
    this.syncColorTemperature(level);
    return true;
  }

  private async getOn(): Promise<CharacteristicValue> {
    const edt = await this.probe(EPC.OPERATION_STATUS);
    if (edt === undefined) {
      this.throwIfUnreachable();
      // Under the miss threshold: fall back to the last cached value so a single lost packet
      // doesn't flap the tile.
      return this.readCached(EPC.OPERATION_STATUS)?.toLowerCase() === EDT_ON;
    }
    return edt.toLowerCase() === EDT_ON;
  }

  private async setOn(value: CharacteristicValue) {
    const on = value as boolean;
    this.platform.log.info(`${ACTOR.HOMEBRIDGE} -> ${this.accessory.displayName} state set to ${on ? 'ON' : 'OFF'}`);
    this.suppressOnUntil = Date.now() + UPDATE_SETTLE_MS;
    // Powering off makes the device report ILLUMINANCE_LEVEL=0. Arm the level window too, in case
    // HomeKit's On characteristic hasn't flipped to false yet when that report lands — belt-and-
    // suspenders with the device-off guard in applyLevel.
    this.suppressLevelUntil = Date.now() + UPDATE_SETTLE_MS;
    this.write(EPC.OPERATION_STATUS, on ? EDT_ON : EDT_OFF);
  }

  private async getBrightness(): Promise<CharacteristicValue> {
    const edt = await this.probe(EPC.ILLUMINANCE_LEVEL);
    if (edt === undefined) {
      this.throwIfUnreachable();
      const cached = this.readCached(EPC.ILLUMINANCE_LEVEL);
      return cached ? edtToLevel(cached) : 0;
    }
    return edtToLevel(edt);
  }

  private async setBrightness(value: CharacteristicValue) {
    const level = value as number;
    this.platform.log.info(
      `${ACTOR.HOMEBRIDGE} -> ${this.accessory.displayName} brightness set to ${level}%`,
    );
    this.queueLevelWrite(level);
    // Deliberately do NOT push a derived ColorTemperature here. Brightness and CT are one device
    // value; an optimistic cross-update is reflected back by the controller as a fresh set, which
    // drives a feedback loop. The CT slider reconciles from the device's reported value
    // (handleChange / poll) once the write settles.
  }

  private async getColorTemperature(): Promise<CharacteristicValue> {
    const edt = await this.probe(EPC.ILLUMINANCE_LEVEL);
    if (edt === undefined) {
      this.throwIfUnreachable();
      const cached = this.readCached(EPC.ILLUMINANCE_LEVEL);
      return this.ctCurve.percentToMired(cached ? edtToLevel(cached) : 0);
    }
    return this.ctCurve.percentToMired(edtToLevel(edt));
  }

  private async setColorTemperature(value: CharacteristicValue) {
    const mired = value as number;
    // Colour temperature has no ECHONET property of its own — it's a HomeKit view of the single
    // ILLUMINANCE_LEVEL — so drive brightness via the inverse curve.
    const level = this.ctCurve.miredToPercent(mired);
    this.platform.log.info(
      `${ACTOR.HOMEBRIDGE} -> ${this.accessory.displayName} temperature set to ${mired} mired (${Math.round(miredToKelvin(mired))}K)`,
    );
    this.queueLevelWrite(level);
    // Deliberately do NOT push a derived Brightness (or snap CT) here. Those optimistic cross-updates
    // are reflected back by the controller as fresh sets and drive a feedback loop. The brightness
    // slider (and the snapped CT) reconcile from the device's reported value once the write settles.
  }

  /**
   * Coalesce a burst of brightness/colour-temperature changes into a single ILLUMINANCE_LEVEL write
   * once the slider settles, and arm update suppression so the device's confirmation of our own value
   * doesn't snap the sliders back. See the module header.
   */
  private queueLevelWrite(level: number) {
    this.pendingLevel = Math.round(level);
    if (this.levelWriteTimer) {
      clearTimeout(this.levelWriteTimer);
    }
    this.levelWriteTimer = setTimeout(() => {
      this.levelWriteTimer = undefined;
      const value = this.pendingLevel!;
      this.suppressLevelUntil = Date.now() + UPDATE_SETTLE_MS;
      this.platform.log.debug(
        `[${this.accessory.displayName}] writing ILLUMINANCE_LEVEL to device: level=${value}% (EDT 0x${levelToEdt(value)})`,
      );
      this.write(EPC.ILLUMINANCE_LEVEL, levelToEdt(value));
    }, LEVEL_WRITE_DEBOUNCE_MS);
  }

  /**
   * Fresh on-the-wire read (bypasses the client cache) that resolves `undefined` when the device
   * stays silent. When `track` is set (the default) the result feeds reachability accounting.
   */
  private async probe(epc: string, track = true): Promise<string | undefined> {
    const edt = await this.platform.client.getProperty(this.ctx.ip, this.ctx.eoj, epc, 1500, { forceRefresh: true });
    if (track) {
      if (edt === undefined) {
        this.registerMiss();
      } else {
        this.registerHit();
      }
    }
    return edt;
  }

  private readCached(epc: string): string | undefined {
    return this.platform.client.getCached(this.ctx.ip, this.ctx.eoj, epc);
  }

  /** A successful probe or inbound frame: reset the miss count and clear any Not Responding state. */
  private registerHit(): void {
    this.consecutiveMisses = 0;
    if (!this.reachable) {
      this.markReachable();
    }
  }

  /** A silent probe: once the threshold is crossed, flip the accessory to Not Responding. */
  private registerMiss(): void {
    this.consecutiveMisses++;
    if (this.reachable && this.consecutiveMisses >= UNREACHABLE_PROBE_THRESHOLD) {
      this.markUnreachable();
    }
  }

  private throwIfUnreachable(): void {
    if (!this.reachable) {
      throw this.commError();
    }
  }

  private commError(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** Push a communication error to the interactive characteristics so HomeKit shows Not Responding. */
  private markUnreachable(): void {
    this.reachable = false;
    this.platform.log.warn(
      `${this.accessory.displayName} is not responding (${this.consecutiveMisses} consecutive probes unanswered)`,
    );
    const { Characteristic } = this.platform;
    this.service.getCharacteristic(Characteristic.On).updateValue(this.commError());
    if (this.isDimmable) {
      this.service.getCharacteristic(Characteristic.Brightness).updateValue(this.commError());
    }
    if (this.hasColorTemperature) {
      this.service.getCharacteristic(Characteristic.ColorTemperature).updateValue(this.commError());
    }
  }

  /** Clear Not Responding by pushing the last-known values back to HomeKit. */
  private markReachable(): void {
    this.reachable = true;
    this.platform.log.info(`${this.accessory.displayName} is responding again`);
    const { Characteristic } = this.platform;
    const on = this.readCached(EPC.OPERATION_STATUS)?.toLowerCase() === EDT_ON;
    this.service.updateCharacteristic(Characteristic.On, on);
    if (this.isDimmable) {
      const levelEdt = this.readCached(EPC.ILLUMINANCE_LEVEL);
      const level = levelEdt ? edtToLevel(levelEdt) : 0;
      this.service.updateCharacteristic(Characteristic.Brightness, level);
      this.syncColorTemperature(level);
    }
  }

  private write(epc: string, edt: string) {
    this.platform.client.setProperty(this.ctx.ip, this.ctx.eoj, epc, edt);
  }
}
