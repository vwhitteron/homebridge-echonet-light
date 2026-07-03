/**
 * Standalone probe: discover ECHONET Lite lighting devices, fetch their property maps,
 * and report whether each is detected as dimmable using the same logic as the plugin.
 *
 * Usage: npx ts-node --esm test/probe-dimmable.ts
 */

import EL from 'echonet-lite';

const CONTROLLER_EOJ = '05ff01';
const LIGHTING_CLASSES = ['0290', '0291'];
const EPC = {
  ILLUMINANCE_LEVEL: 'b0',
  MAX_SPECIFIABLE_ILLUMINANCE_LEVEL: 'b4',
  IDENTIFICATION_NUMBER: '83',
  SET_PROPERTY_MAP: '9e',
  GET_PROPERTY_MAP: '9f',
} as const;

const TARGET_ID_SUFFIX = 'e01ab9';
const DISCOVERY_WAIT_MS = 8000;
const PROPERTY_TIMEOUT_MS = 3000;

// ── Property-map parser (mirrors client.ts) ──────────────────────────────────

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function parsePropertyMap(edt: string): string[] {
  const bytes = hexToBytes(edt);
  if (bytes.length === 0) return [];
  const count = bytes[0];
  const body = bytes.slice(1);
  const epcs: string[] = [];

  if (body.length === 16) {
    for (let n = 0; n < 16; n++) {
      for (let m = 0; m < 8; m++) {
        if (body[n] & (1 << m)) {
          epcs.push(((m + 8) * 16 + n).toString(16).padStart(2, '0'));
        }
      }
    }
  } else {
    for (const b of body.slice(0, count)) {
      epcs.push(b.toString(16).padStart(2, '0'));
    }
  }
  return epcs;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Facilities = Record<string, Record<string, Record<string, string>>>;

function getCached(ip: string, eoj: string, epc: string): string | undefined {
  return (EL.facilities as Facilities)[ip]?.[eoj]?.[epc.toLowerCase()];
}

function supportsProperty(ip: string, eoj: string, epc: string): boolean {
  const target = epc.toLowerCase();
  for (const mapEpc of [EPC.GET_PROPERTY_MAP, EPC.SET_PROPERTY_MAP]) {
    const map = getCached(ip, eoj, mapEpc);
    if (map && parsePropertyMap(map).includes(target)) return true;
  }
  return false;
}

// Pending getProperty callbacks, keyed by `ip|eoj|epc`
const pending = new Map<string, Array<(edt: string) => void>>();

function onFrame(rinfo: { address: string }, els: { SEOJ: string; OPC: number; PROP: Array<{ EPC: number; EDT: string }> }) {
  if (!els?.PROP) return;
  for (const prop of els.PROP) {
    const epc = prop.EPC.toString(16).padStart(2, '0');
    const key = `${rinfo.address}|${els.SEOJ?.toLowerCase()}|${epc}`;
    const waiters = pending.get(key);
    if (waiters?.length) {
      const raw = prop.EDT as unknown;
      const edt = typeof raw === 'string' ? raw
        : (Array.isArray(raw) ? (raw as number[]).map(b => b.toString(16).padStart(2, '0')).join('') : '');
      for (const resolve of waiters) resolve(edt);
      pending.delete(key);
    }
  }
}

function getProperty(ip: string, eoj: string, epc: string): Promise<string | undefined> {
  const cached = getCached(ip, eoj, epc);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const target = epc.toLowerCase();
    // Match on any instance of this EOJ class (ignore instance byte for map)
    const classPrefix = eoj.slice(0, 4).toLowerCase();
    // Register with wildcard-ish key — try both the exact EOJ and class-only
    const key = `${ip}|${eoj.toLowerCase()}|${target}`;
    const classKey = `${ip}|${classPrefix}|${target}`;

    const fulfill = (edt: string) => {
      clearTimeout(timer);
      pending.delete(key);
      pending.delete(classKey);
      resolve(edt);
    };

    const timer = setTimeout(() => {
      pending.delete(key);
      pending.delete(classKey);
      resolve(getCached(ip, eoj, epc));
    }, PROPERTY_TIMEOUT_MS);

    for (const k of [key, classKey]) {
      const list = pending.get(k) ?? [];
      list.push(fulfill);
      pending.set(k, list);
    }

    EL.sendOPC1(ip, CONTROLLER_EOJ, eoj, EL.GET, epc, '');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting ECHONET Lite discovery...\n');

  EL.initialize([CONTROLLER_EOJ], onFrame, 4, { ignoreMe: true, autoGetProperties: true, debugMode: true });
  // Give the UDP socket time to bind before sending the multicast search
  await new Promise(r => setTimeout(r, 500));
  EL.search();

  console.log(`Waiting ${DISCOVERY_WAIT_MS / 1000}s for devices to respond...`);
  await new Promise(r => setTimeout(r, DISCOVERY_WAIT_MS));
  console.log();

  const facilities = EL.facilities as Facilities;
  const devices: { ip: string; eoj: string }[] = [];

  for (const [ip, objects] of Object.entries(facilities)) {
    for (const eoj of Object.keys(objects)) {
      if (LIGHTING_CLASSES.includes(eoj.slice(0, 4).toLowerCase())) {
        devices.push({ ip, eoj });
      }
    }
  }

  console.log(`Discovered ${devices.length} lighting device(s).\n`);

  if (devices.length === 0) {
    console.log('Raw facilities dump:');
    console.log(JSON.stringify(facilities, null, 2));
    EL.release();
    return;
  }

  for (const { ip, eoj } of devices) {
    await Promise.all([
      getProperty(ip, eoj, EPC.GET_PROPERTY_MAP),
      getProperty(ip, eoj, EPC.SET_PROPERTY_MAP),
    ]);
    const idEdt = await getProperty(ip, eoj, EPC.IDENTIFICATION_NUMBER);
    const id = idEdt ?? `${ip}-${eoj}`;

    const hasB0 = supportsProperty(ip, eoj, EPC.ILLUMINANCE_LEVEL);
    const hasB4 = supportsProperty(ip, eoj, EPC.MAX_SPECIFIABLE_ILLUMINANCE_LEVEL);
    const isDimmable = hasB0 || hasB4;
    const serviceType = isDimmable ? 'Lightbulb (dimmable)' : 'Switch (on/off only)';

    const getMap = getCached(ip, eoj, EPC.GET_PROPERTY_MAP);
    const setMap = getCached(ip, eoj, EPC.SET_PROPERTY_MAP);
    const getEpcs = getMap ? parsePropertyMap(getMap) : [];
    const setEpcs = setMap ? parsePropertyMap(setMap) : [];

    const isTarget = id.toLowerCase().includes(TARGET_ID_SUFFIX);
    const marker = isTarget ? '  ◀◀ TARGET' : '';

    console.log(`Device  : ${ip}  EOJ: ${eoj}  ID: ${id}${marker}`);
    console.log(`  0xB0 (brightness) : ${hasB0}   0xB4 (max-specifiable): ${hasB4}`);
    console.log(`  → Service type    : ${serviceType}`);
    console.log(`  GET map EPCs      : [${getEpcs.join(', ')}]`);
    console.log(`  SET map EPCs      : [${setEpcs.join(', ')}]`);
    console.log();
  }

  EL.release();
}

main().catch(err => { console.error(err); process.exit(1); });
