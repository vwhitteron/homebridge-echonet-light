// Integration harness: drives the plugin's EchonetClient against the elemu
// emulator over real ECHONET Lite UDP, confined to the Docker bridge network.
//
// Validates the networked behaviour that unit tests cannot: multicast discovery,
// property reads, capability detection, writes, and INF (out-of-band) subscription.
import * as dns from 'node:dns/promises';

import EL from 'echonet-lite';

import { EchonetClient, parsePropertyMap } from '../../dist/echonet/client.js';
import { CONTROLLER_EOJ, EPC } from '../../dist/settings.js';

const ELEMU_HOST = process.env.ELEMU_HOST ?? 'elemu';
const DASH = process.env.ELEMU_DASHBOARD ?? `http://${ELEMU_HOST}:8880`;
const EOJ = '029001';

const log = { debug: () => {}, info: console.log, warn: console.warn, error: console.error, log: console.log };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  ok ? passed++ : failed++;
};

// Issue a GET that bypasses the client cache and wait for the fresh response.
function forceGet(client, ip, eoj, epc, timeoutMs = 2500) {
  const target = epc.toLowerCase();
  return new Promise((resolve) => {
    const onChange = (c) => {
      if (c.ip === ip && c.eoj.toLowerCase() === eoj.toLowerCase() && c.epc === target) {
        clearTimeout(timer);
        client.off('change', onChange);
        resolve(c.edt);
      }
    };
    const timer = setTimeout(() => {
      client.off('change', onChange);
      resolve(client.getCached(ip, eoj, epc));
    }, timeoutMs);
    client.on('change', onChange);
    EL.sendOPC1(ip, CONTROLLER_EOJ, eoj, EL.GET, epc, '');
  });
}

const edtToLevel = (edt) => parseInt(String(edt).slice(0, 2), 16);

async function main() {
  const { address: ip } = await dns.lookup(ELEMU_HOST, 4);
  console.log(`\nelemu resolved to ${ip}; starting EchonetClient...\n`);

  const client = new EchonetClient(log);
  client.start(4);

  // --- Test A: multicast discovery across the bridge -------------------------
  await sleep(1500);
  client.search();
  await sleep(3000);

  const discovered = client.discover();
  const lights = discovered.filter((d) => d.eoj.slice(0, 4) === '0290' || d.eoj.slice(0, 4) === '0291');
  const foundElemu = lights.some((d) => d.ip === ip && d.eoj.toLowerCase() === EOJ);
  check('A. multicast discovery finds elemu general lighting', foundElemu, `discovered=${JSON.stringify(discovered)}`);

  // Confirm isolation: nothing from the host's real LAN leaked in.
  const foreign = discovered.filter((d) => d.ip !== ip);
  check('A2. no foreign (real-LAN) devices discovered', foreign.length === 0, `foreign=${JSON.stringify(foreign)}`);

  // --- Test B: property reads (identity + state) -----------------------------
  const idn = await client.getProperty(ip, EOJ, EPC.IDENTIFICATION_NUMBER);
  check('B1. identification number (0x83) readable', !!idn && idn.length >= 4, `idn=${idn}`);

  const mfr = await client.getProperty(ip, EOJ, EPC.MANUFACTURER_CODE);
  check('B2. manufacturer code (0x8A) readable', !!mfr, `mfr=${mfr}`);

  const onState = await client.getProperty(ip, EOJ, EPC.OPERATION_STATUS);
  check('B3. operation status (0x80) is ON (30)', onState?.toLowerCase() === '30', `edt=${onState}`);

  const level = await client.getProperty(ip, EOJ, EPC.ILLUMINANCE_LEVEL);
  check('B4. brightness (0xB0) reads seeded 80%', edtToLevel(level) === 80, `edt=${level} -> ${edtToLevel(level)}%`);

  // --- Test C: capability detection (would become a dimmable Lightbulb) ------
  const getMap = client.getCached(ip, EOJ, EPC.GET_PROPERTY_MAP);
  const epcs = getMap ? parsePropertyMap(getMap) : [];
  check('C1. brightness EPC present in Get property map', epcs.includes('b0'), `map=${epcs.join(',')}`);
  check('C2. supportsProperty(0xB0) => dimmable Lightbulb', client.supportsProperty(ip, EOJ, EPC.ILLUMINANCE_LEVEL));

  // --- Test D: writes (HomeKit -> device) ------------------------------------
  client.setProperty(ip, EOJ, EPC.OPERATION_STATUS, '31'); // OFF
  await sleep(600);
  const offState = await forceGet(client, ip, EOJ, EPC.OPERATION_STATUS);
  check('D1. SET operation status OFF takes effect', offState?.toLowerCase() === '31', `edt=${offState}`);

  client.setProperty(ip, EOJ, EPC.ILLUMINANCE_LEVEL, '32'); // 0x32 = 50%
  await sleep(600);
  const newLevel = await forceGet(client, ip, EOJ, EPC.ILLUMINANCE_LEVEL);
  check('D2. SET brightness 50% takes effect', edtToLevel(newLevel) === 50, `edt=${newLevel} -> ${edtToLevel(newLevel)}%`);

  // --- Test E: INF subscription (device -> HomeKit, out of band) -------------
  const infReceived = new Promise((resolve) => {
    const onChange = (c) => {
      if (c.ip === ip && c.eoj.toLowerCase() === EOJ && c.epc === EPC.OPERATION_STATUS && c.edt.toLowerCase() === '30') {
        client.off('change', onChange);
        resolve(true);
      }
    };
    client.on('change', onChange);
    setTimeout(() => { client.off('change', onChange); resolve(false); }, 4000);
  });
  // Flip the light back ON via the emulator's REST API (simulates an external change).
  await fetch(`${DASH}/api/device/eojs/${EOJ}/epcs/80`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edt: '30' }),
  });
  check('E. out-of-band ON change delivered via INF subscription', await infReceived);

  client.stop();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
