import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PropertyChange } from './echonet/client.js';
import { createColourTemperatureCurve, type ColourTemperatureCurveImpl } from './echonet/colorTemperature.js';
import { MANUFACTURERS } from './echonet/manufacturers.js';
import type { AccessoryContext, EchonetLightPlatform } from './platform.js';
import {
  EDT_OFF,
  EDT_ON,
  EPC,
  LEVEL_MAX,
} from './settings.js';

/**
 * Brightness and colour temperature are both backed by the single ILLUMINANCE_LEVEL property, so a
 * slider drag fires a burst of onSet calls. We coalesce them into one write after the drag settles,
 * and ignore the device's echo of our own value for a short window so it doesn't yank the slider.
 */
const LEVEL_WRITE_DEBOUNCE_MS = 250;
const ECHO_SUPPRESS_MS = 1500;

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
  private readonly isLightbulb: boolean;
  private readonly hasColorTemperature: boolean;
  private readonly ctCurve: ColourTemperatureCurveImpl;

  /** Debounce state for coalescing brightness/colour-temperature writes (see module header). */
  private pendingLevel?: number;
  private levelWriteTimer?: ReturnType<typeof setTimeout>;
  private suppressEchoUntil = 0;

  constructor(
    private readonly platform: EchonetLightPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.ctx = accessory.context.device as AccessoryContext;
    this.ctCurve = createColourTemperatureCurve();
    const { ip, eoj } = this.ctx;
    const client = this.platform.client;

    this.setAccessoryInformation();

    this.isLightbulb =
      client.supportsProperty(ip, eoj, EPC.ILLUMINANCE_LEVEL) ||
      client.supportsProperty(ip, eoj, EPC.MAX_SPECIFIABLE_ILLUMINANCE_LEVEL);
    // Colour temperature is derived from brightness, so it only applies to dimmable lights.
    this.hasColorTemperature = this.isLightbulb && this.ctx.synchroColourTone;

    const { Service, Characteristic } = this.platform;

    if (this.isLightbulb) {
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

    if (this.isLightbulb) {
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
    const { Characteristic } = this.platform;
    const name = this.accessory.displayName;

    this.platform.log.debug(`[${name}] refreshState: polling device`);

    const [statusEdt, levelEdt] = await Promise.all([
      this.read(EPC.OPERATION_STATUS),
      this.isLightbulb ? this.read(EPC.ILLUMINANCE_LEVEL) : Promise.resolve(undefined),
    ]);

    if (statusEdt !== undefined) {
      const on = statusEdt.toLowerCase() === EDT_ON;
      const currentOn = this.service.getCharacteristic(Characteristic.On).value;
      if (on !== currentOn) {
        this.platform.log.debug(`[${name}] refreshState: on changed ${currentOn} → ${on}`);
        this.service.updateCharacteristic(Characteristic.On, on);
      }
    } else {
      this.platform.log.debug(`[${name}] refreshState: no response for OPERATION_STATUS`);
    }

    if (levelEdt !== undefined) {
      // Don't overwrite a value the user is actively setting.
      const isWritePending = this.levelWriteTimer !== undefined || Date.now() < this.suppressEchoUntil;
      if (isWritePending) {
        this.platform.log.debug(`[${name}] refreshState: skipping ILLUMINANCE_LEVEL update (write in progress)`);
      } else {
        const level = edtToLevel(levelEdt);
        const currentLevel = this.service.getCharacteristic(Characteristic.Brightness).value;
        if (level !== currentLevel) {
          this.platform.log.debug(`[${name}] refreshState: level changed ${currentLevel} → ${level}%`);
          this.service.updateCharacteristic(Characteristic.Brightness, level);
          this.syncColorTemperature(level);
        }
      }
    } else if (this.isLightbulb) {
      this.platform.log.debug(`[${name}] refreshState: no response for ILLUMINANCE_LEVEL`);
    }
  }

  /** Route a live property change from the network to the relevant HomeKit characteristic. */
  handleChange(change: PropertyChange) {
    if (change.ip !== this.ctx.ip || change.eoj.toLowerCase() !== this.ctx.eoj.toLowerCase()) {
      return;
    }
    const { Characteristic } = this.platform;
    switch (change.epc) {
    case EPC.OPERATION_STATUS: {
      const on = change.edt.toLowerCase() === EDT_ON;
      this.platform.log.info(`[${this.accessory.displayName}] on changed → ${on}`);
      this.service.updateCharacteristic(Characteristic.On, on);
      break;
    }
    case EPC.ILLUMINANCE_LEVEL:
      if (this.isLightbulb) {
        const level = edtToLevel(change.edt);
        // While a write is pending or we're inside the echo-suppression window, the value the user
        // just set is authoritative. Ignore *any* incoming level report in that window — not just
        // exact echoes — because devices often emit a stale/transient report (e.g. 0%) mid-drag that
        // would otherwise shove the brightness/colour-temperature sliders around.
        const isOwnEcho =
          this.levelWriteTimer !== undefined || Date.now() < this.suppressEchoUntil;
        if (isOwnEcho) {
          this.platform.log.debug(
            `[${this.accessory.displayName}] brightness change suppressed (own echo): level=${level}%`,
          );
        } else {
          this.platform.log.info(
            `[${this.accessory.displayName}] brightness changed → ${level}%`,
          );
          this.service.updateCharacteristic(Characteristic.Brightness, level);
          this.syncColorTemperature(level);
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

  private async getOn(): Promise<CharacteristicValue> {
    const edt = await this.read(EPC.OPERATION_STATUS);
    return edt?.toLowerCase() === EDT_ON;
  }

  private async setOn(value: CharacteristicValue) {
    const on = value as boolean;
    this.platform.log.info(`[${this.accessory.displayName}] set on=${on}`);
    this.write(EPC.OPERATION_STATUS, on ? EDT_ON : EDT_OFF);
  }

  private async getBrightness(): Promise<CharacteristicValue> {
    const edt = await this.read(EPC.ILLUMINANCE_LEVEL);
    return edt ? edtToLevel(edt) : 0;
  }

  private async setBrightness(value: CharacteristicValue) {
    const level = value as number;
    this.platform.log.info(
      `[${this.accessory.displayName}] brightness set → ${level}%`,
    );
    this.queueLevelWrite(level);
    // Deliberately do NOT push a derived ColorTemperature here. Brightness and CT are one device
    // value; an optimistic cross-update is reflected back by the controller as a fresh set, which
    // drives a feedback loop. The CT slider reconciles from the device's reported value
    // (handleChange / poll) once the write settles.
  }

  private async getColorTemperature(): Promise<CharacteristicValue> {
    const edt = await this.read(EPC.ILLUMINANCE_LEVEL);
    return this.ctCurve.percentToMired(edt ? edtToLevel(edt) : 0);
  }

  private async setColorTemperature(value: CharacteristicValue) {
    const mired = value as number;
    // Colour temperature has no ECHONET property of its own — it's a HomeKit view of the single
    // ILLUMINANCE_LEVEL — so drive brightness via the inverse curve.
    const level = this.ctCurve.miredToPercent(mired);
    this.platform.log.info(
      `[${this.accessory.displayName}] colour temperature set → ${mired} mired (brightness level=${level}%)`,
    );
    this.queueLevelWrite(level);
    // Deliberately do NOT push a derived Brightness (or snap CT) here. Those optimistic cross-updates
    // are reflected back by the controller as fresh sets and drive a feedback loop. The brightness
    // slider (and the snapped CT) reconcile from the device's reported value once the write settles.
  }

  /**
   * Coalesce a burst of brightness/colour-temperature changes into a single ILLUMINANCE_LEVEL write
   * once the slider settles, and arm echo suppression so the device's confirmation of our own value
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
      this.suppressEchoUntil = Date.now() + ECHO_SUPPRESS_MS;
      this.platform.log.debug(
        `[${this.accessory.displayName}] writing ILLUMINANCE_LEVEL to device: level=${value}% (EDT 0x${levelToEdt(value)})`,
      );
      this.write(EPC.ILLUMINANCE_LEVEL, levelToEdt(value));
    }, LEVEL_WRITE_DEBOUNCE_MS);
  }

  private read(epc: string): Promise<string | undefined> {
    return this.platform.client.getProperty(this.ctx.ip, this.ctx.eoj, epc);
  }

  private write(epc: string, edt: string) {
    this.platform.client.setProperty(this.ctx.ip, this.ctx.eoj, epc, edt);
  }
}
