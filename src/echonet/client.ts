import { EventEmitter } from 'node:events';
import type { RemoteInfo } from 'node:dgram';

import EL from 'echonet-lite';
import type { ELDATA } from 'echonet-lite';
import type { Logging } from 'homebridge';

import { CONTROLLER_EOJ, EPC, LIGHTING_CLASSES, UPDATE_SETTLE_MS } from '../settings.js';

/** A lighting device object located on the network. */
export interface DiscoveredDevice {
  ip: string;
  eoj: string;
}

/** A single EPC state change reported by a device. */
export interface PropertyChange {
  ip: string;
  eoj: string;
  epc: string;
  edt: string;
}

/** Minimal key for matching a SET_RES acknowledgement back to a pending write. */
export interface SetAck {
  ip: string;
  eoj: string;
  epc: string;
}

export interface EchonetClientEvents {
  change: [PropertyChange];
  setack: [SetAck];
}

const toHex = (byte: number): string => byte.toString(16).padStart(2, '0');

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Parse an ECHONET property map (EPC 0x9D/0x9E/0x9F) into a list of EPC hex strings.
 *
 * The first byte is the property count. Format is distinguished by the body length, not the
 * count: an explicit EPC list has a body of exactly `count` bytes, while the 16-byte bitmap form
 * (used by the wire protocol when count ≥ 16) has a 16-byte body. Note that `echonet-lite`
 * normalises maps in its `facilities` cache to the explicit-list form even when count ≥ 16, so the
 * length check — rather than `count < 16` — is what keeps parsing correct.
 */
export function parsePropertyMap(edt: string): string[] {
  const bytes = hexToBytes(edt);
  if (bytes.length === 0) {
    return [];
  }
  const count = bytes[0];
  const body = bytes.slice(1);

  // Bitmap form: 16 bytes where bit m of byte n means EPC 0x(m+8)(n) is present.
  if (body.length === 16 && body.length !== count) {
    const epcs: string[] = [];
    for (let n = 0; n < 16; n++) {
      for (let m = 0; m < 8; m++) {
        if (body[n] & (1 << m)) {
          epcs.push(toHex((m + 8) * 16 + n));
        }
      }
    }
    return epcs;
  }

  // Explicit list: the body is the EPC list directly.
  return body.slice(0, count).map(toHex);
}

/**
 * Typed, promise/event wrapper around the `echonet-lite` package.
 *
 * - {@link start} initialises the UDP socket (as a controller object) and broadcasts a search.
 * - {@link discover} reads the library's `facilities` cache for lighting device objects.
 * - {@link getProperty} / {@link setProperty} read/write a single EPC.
 * - Emits `change` for every incoming INF (status announcement) frame so callers can push
 *   out-of-band updates straight to HomeKit.
 */
export class EchonetClient extends EventEmitter<EchonetClientEvents> {
  private started = false;

  /** In-flight GETs keyed by "ip:eoj:epc" so concurrent reads of the same property share a single
   *  request instead of each issuing its own GET — see {@link getProperty}. */
  private readonly inflightGets = new Map<string, Promise<string | undefined>>();

  /**
   * Serialised SET queues per device IP.
   *
   * ECHONET Lite devices process SETC frames sequentially — sending a second SETC before receiving
   * the SET_RES for the first confuses most devices and causes them to stop responding. We chain
   * every SET for the same IP onto a promise tail so they run one at a time.
   */
  private readonly deviceQueues = new Map<string, Promise<void>>();

  /** Dedup table: "ip:eoj:epc:edt" → timestamp of last emission. See {@link emitChange}. */
  private readonly recentChanges = new Map<string, number>();

  constructor(private readonly log: Logging) {
    super();
    // Each concurrent getProperty call adds one listener; allow up to 200 in-flight requests.
    this.setMaxListeners(200);
  }

  start(ipVer: number): void {
    if (this.started) {
      return;
    }
    this.started = true;

    EL.initialize([CONTROLLER_EOJ], (rinfo, els, err) => this.onFrame(rinfo, els, err), ipVer, {
      ignoreMe: true,
      autoGetProperties: true,
    });

    // Broadcast an initial discovery request; devices reply and populate `EL.facilities`.
    EL.search();
  }

  /** Trigger another multicast discovery (used by the periodic refresh). */
  search(): void {
    EL.search();
  }

  /** Inspect the library's facilities cache and return all supported lighting device objects. */
  discover(): DiscoveredDevice[] {
    const devices: DiscoveredDevice[] = [];
    for (const [ip, objects] of Object.entries(EL.facilities)) {
      for (const eoj of Object.keys(objects)) {
        if (LIGHTING_CLASSES.includes(eoj.slice(0, 4).toLowerCase())) {
          devices.push({ ip, eoj });
        }
      }
    }
    return devices;
  }

  /** Latest cached EDT (hex) for an EPC, or undefined if not yet known. */
  getCached(ip: string, eoj: string, epc: string): string | undefined {
    return EL.facilities[ip]?.[eoj]?.[epc.toLowerCase()];
  }

  /** Whether an EPC is advertised in the device's Get or Set property map. */
  supportsProperty(ip: string, eoj: string, epc: string): boolean {
    const target = epc.toLowerCase();
    for (const mapEpc of [EPC.GET_PROPERTY_MAP, EPC.SET_PROPERTY_MAP]) {
      const map = this.getCached(ip, eoj, mapEpc);
      if (map && parsePropertyMap(map).includes(target)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read a property. Returns the cached value immediately if present, otherwise issues a GET and
   * waits for the matching GET_RES frame (with a timeout).
   */
  async getProperty(ip: string, eoj: string, epc: string, timeoutMs = 1500): Promise<string | undefined> {
    const cached = this.getCached(ip, eoj, epc);
    if (cached !== undefined) {
      return cached;
    }
    const target = epc.toLowerCase();
    // Coalesce concurrent reads of the same property. A colour-temperature light exposes both
    // Brightness and ColorTemperature, both backed by ILLUMINANCE_LEVEL, so HomeKit's startup reads
    // fire two onGet calls; without this each issues its own GET and the device answers both,
    // surfacing as duplicate state-change reports. Share one in-flight GET instead.
    const key = `${ip}:${eoj.toLowerCase()}:${target}`;
    const existing = this.inflightGets.get(key);
    if (existing) {
      return existing;
    }
    const request = new Promise<string | undefined>((resolve) => {
      // eslint-disable-next-line prefer-const -- timer and onChange reference each other
      let timer: NodeJS.Timeout;
      const onChange = (change: PropertyChange) => {
        if (change.ip === ip && change.eoj.toLowerCase() === eoj.toLowerCase() && change.epc === target) {
          clearTimeout(timer);
          this.off('change', onChange);
          this.inflightGets.delete(key);
          resolve(change.edt);
        }
      };
      timer = setTimeout(() => {
        this.off('change', onChange);
        this.inflightGets.delete(key);
        resolve(this.getCached(ip, eoj, epc));
      }, timeoutMs);
      this.on('change', onChange);
      EL.sendOPC1(ip, CONTROLLER_EOJ, eoj, EL.GET, epc, '');
    });
    this.inflightGets.set(key, request);
    return request;
  }

  /** Write a property (SETC), serialised per device IP. `edt` is a hex string. */
  setProperty(ip: string, eoj: string, epc: string, edt: string): void {
    const tail = this.deviceQueues.get(ip) ?? Promise.resolve();
    const next = tail.then(() => this.sendSetc(ip, eoj, epc, edt), () => this.sendSetc(ip, eoj, epc, edt));
    this.deviceQueues.set(ip, next);
  }

  /**
   * Send a SETC frame and resolve once the device sends SET_RES, or after a timeout.
   * Resolving on timeout (rather than rejecting) keeps the queue draining even when a device is
   * slow or unreachable.
   */
  private sendSetc(ip: string, eoj: string, epc: string, edt: string, timeoutMs = 2000): Promise<void> {
    return new Promise<void>((resolve) => {
      const target = epc.toLowerCase();
      // eslint-disable-next-line prefer-const -- timer and onAck reference each other
      let timer: NodeJS.Timeout;
      const onAck = (ack: SetAck) => {
        if (
          ack.ip === ip &&
          ack.eoj.toLowerCase() === eoj.toLowerCase() &&
          ack.epc === target
        ) {
          clearTimeout(timer);
          this.off('setack', onAck);
          // Emit an optimistic change with the value we wrote so HomeKit updates immediately.
          // If the INF arrives later with the same value, emitChange's dedup will suppress it.
          this.emitChange({ ip, eoj, epc: target, edt });
          resolve();
        }
      };
      timer = setTimeout(() => {
        this.off('setack', onAck);
        resolve();
      }, timeoutMs);
      this.on('setack', onAck);
      EL.sendOPC1(ip, CONTROLLER_EOJ, eoj, EL.SETC, epc, edt);
    });
  }

  /**
   * Emit a change event with deduplication. Records the key so a subsequent frame carrying the
   * same (ip, eoj, epc, edt) within UPDATE_SETTLE_MS is suppressed — preventing the INF
   * that follows a write from producing a second HomeKit update after the optimistic one.
   */
  private emitChange(change: PropertyChange): void {
    const key = `${change.ip}:${change.eoj}:${change.epc}:${change.edt}`;
    const now = Date.now();
    const last = this.recentChanges.get(key) ?? 0;
    if (now - last < UPDATE_SETTLE_MS) {
      return;
    }
    this.recentChanges.set(key, now);
    // Evict stale entries to keep the map bounded.
    if (this.recentChanges.size > 500) {
      const cutoff = now - UPDATE_SETTLE_MS;
      for (const [k, ts] of this.recentChanges) {
        if (ts < cutoff) {
          this.recentChanges.delete(k);
        }
      }
    }
    this.emit('change', change);
  }

  stop(): void {
    if (this.started) {
      EL.release();
      this.started = false;
    }
  }

  private onFrame(rinfo: RemoteInfo, els: ELDATA | null, err: Error | null): void {
    if (err) {
      this.log.debug('ECHONET frame error:', err.message);
      return;
    }
    if (!els || !els.DETAILs) {
      return;
    }
    const ip = rinfo.address;
    const eoj = els.SEOJ;
    if (els.ESV === EL.SET_RES) {
      // SET_RES (ESV 0x71) is a unicast acknowledgement: EDT is empty (PDC=0) on success, so it
      // carries no current value. Emit setack so the write queue resolves promptly, but do not
      // surface this as a state change — the device's subsequent INF carries the actual value.
      for (const epc of Object.keys(els.DETAILs)) {
        this.emit('setack', { ip, eoj, epc: epc.toLowerCase() });
      }
    } else {
      // GET_RES (0x72) and INF (0x73) carry actual current values; surface them as change events
      // so pending reads resolve and HomeKit stays in sync with out-of-band state changes.
      for (const [epc, edt] of Object.entries(els.DETAILs)) {
        this.emitChange({ ip, eoj, epc: epc.toLowerCase(), edt });
      }
    }
  }
}
