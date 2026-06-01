import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { EchonetClient, parsePropertyMap } from './echonet/client.js';
import type { DiscoveredDevice } from './echonet/client.js';
import { EchonetLightAccessory } from './platformAccessory.js';
import {
  DEFAULT_INITIAL_SCAN_DELAY_MS,
  DEFAULT_DISCOVERY_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  EPC,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings.js';

/** Per-device override block from the plugin config. */
interface DeviceConfig {
  serialNumber: string;
  synchroColourTone?: boolean;
}

/** Data persisted in `accessory.context.device`. */
export interface AccessoryContext {
  ip: string;
  eoj: string;
  identificationNumber: string;
  /** Expose a HomeKit ColorTemperature characteristic derived from brightness. */
  synchroColourTone: boolean;
}

export class EchonetLightPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  /** Active accessory handlers, keyed by "ip:eoj" for O(1) change routing. */
  private readonly handlers: Map<string, EchonetLightAccessory> = new Map();

  public readonly client: EchonetClient;
  private refreshTimer?: NodeJS.Timeout;
  private statePollTimer?: NodeJS.Timeout;

  // Resolved config.
  private readonly ipVersion: number;
  private readonly discoveryIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly initialScanDelayMs: number;
  private readonly synchroColourTone: boolean;
  private readonly deviceConfigs: Map<string, DeviceConfig> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.ipVersion = typeof config.ipVersion === 'number' ? config.ipVersion : 4;
    this.discoveryIntervalMs = (config.discoveryInterval ?? DEFAULT_DISCOVERY_INTERVAL) * 1000;
    this.pollIntervalMs = (config.pollInterval ?? DEFAULT_POLL_INTERVAL) * 1000;
    this.initialScanDelayMs = typeof config.initialScanDelay === 'number'
      ? config.initialScanDelay * 1000
      : DEFAULT_INITIAL_SCAN_DELAY_MS;
    this.synchroColourTone = config.synchroColourTone === true;
    for (const device of (config.devices ?? []) as DeviceConfig[]) {
      if (device?.serialNumber) {
        this.deviceConfigs.set(device.serialNumber, device);
      }
    }

    this.client = new EchonetClient(this.log);

    this.api.on('didFinishLaunching', () => {
      this.client.start(this.ipVersion);

      // Route live property changes to the matching accessory handler.
      this.client.on('change', (change) => {
        const handler = this.handlers.get(`${change.ip}:${change.eoj.toLowerCase()}`);
        handler?.handleChange(change);
      });

      // Give devices a moment to respond to the initial search, then discover and keep polling.
      setTimeout(() => this.discoverDevices(), this.initialScanDelayMs);
      this.refreshTimer = setInterval(() => {
        this.client.search();
        this.discoverDevices();
      }, this.discoveryIntervalMs);

      this.statePollTimer = setInterval(() => {
        for (const handler of this.handlers.values()) {
          handler.refreshState().catch((err: Error) => this.log.debug('State poll error:', err.message));
        }
      }, this.pollIntervalMs);
    });

    this.api.on('shutdown', () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
      }
      if (this.statePollTimer) {
        clearInterval(this.statePollTimer);
      }
      this.client.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    const ctx = accessory.context.device as AccessoryContext | undefined;
    const idHint = ctx?.identificationNumber
      ? ` (serialNumber: ${ctx.identificationNumber})`
      : '';
    this.log.info(`Loading accessory from cache: ${accessory.displayName}${idHint}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Discover lighting devices currently visible on the network and register/refresh accessories. */
  async discoverDevices() {
    const discovered = this.client.discover();
    this.log.debug(`Discovery found ${discovered.length} lighting device object(s).`);

    // Group by IP so requests to the same physical device stay sequential,
    // then run each IP's group in parallel with the others.
    const byIp = new Map<string, DiscoveredDevice[]>();
    for (const device of discovered) {
      const group = byIp.get(device.ip) ?? [];
      group.push(device);
      byIp.set(device.ip, group);
    }

    const instanceCounters = new Map<string, number>();

    await Promise.allSettled([...byIp.values()].map(async (group) => {
      for (const device of group) {
        try {
          await this.registerDevice(device, instanceCounters);
        } catch (error) {
          this.log.warn(`Failed to set up ${device.ip} ${device.eoj}:`, (error as Error).message);
        }
      }
    }));
  }

  private async registerDevice(device: DiscoveredDevice, instanceCounters: Map<string, number>) {
    const { ip, eoj } = device;

    // Fetch property maps first so we know which EPCs the device supports before issuing further GETs.
    const [getMap, setMap] = await Promise.all([
      this.client.getProperty(ip, eoj, EPC.GET_PROPERTY_MAP),
      this.client.getProperty(ip, eoj, EPC.SET_PROPERTY_MAP),
    ]);

    const readable = getMap ? parsePropertyMap(getMap) : [];
    const hasGetProperty = (epc: string) => readable.includes(epc.toLowerCase());

    const [idEdt, manufacturerCode, productCode] = await Promise.all([
      this.client.getProperty(ip, eoj, EPC.IDENTIFICATION_NUMBER),
      hasGetProperty(EPC.MANUFACTURER_CODE) ? this.client.getProperty(ip, eoj, EPC.MANUFACTURER_CODE) : undefined,
      hasGetProperty(EPC.PRODUCT_CODE) ? this.client.getProperty(ip, eoj, EPC.PRODUCT_CODE) : undefined,
    ]);

    // Persistent identity: ECHONET identification number (EPC 0x83) is required.
    // Skip provisioning if it could not be fetched — a transient network failure should not
    // register a phantom accessory with a garbage name derived from the IP address.
    if (!idEdt || idEdt === '') {
      this.log.warn(`Skipping ${ip} ${eoj}: could not fetch identification number (EPC 0x83).`);
      return;
    }
    const identificationNumber = idEdt;
    const uuid = this.api.hap.uuid.generate(`echonet-${identificationNumber}`);

    const deviceConfig = this.deviceConfigs.get(identificationNumber);

    const shortId = identificationNumber.slice(-6);

    const dimmable = this.client.supportsProperty(ip, eoj, EPC.ILLUMINANCE_LEVEL) ||
      this.client.supportsProperty(ip, eoj, EPC.MAX_SPECIFIABLE_ILLUMINANCE_LEVEL);

    // Synchro Colour Tone is a derived HomeKit relationship (per-device override falls back to global).
    // Only meaningful for dimmable devices — force false for switches.
    const synchroColourTone = dimmable && (
      deviceConfig !== undefined
        ? (deviceConfig.synchroColourTone ?? false)
        : this.synchroColourTone
    );

    const context: AccessoryContext = {
      ip,
      eoj,
      identificationNumber,
      synchroColourTone,
    };

    const instanceNumber = (instanceCounters.get(shortId) ?? 0) + 1;
    instanceCounters.set(shortId, instanceNumber);
    const displayName = `${dimmable ? 'Light' : 'Switch'} ${shortId}.${instanceNumber}`;

    this.log.debug(
      `[Discovery] ${ip} ${eoj}\n` +
      `  name         : ${displayName}\n` +
      `  id      0x83 : ${identificationNumber}\n` +
      `  mfr     0x8a : ${manufacturerCode ?? '(none)'}\n` +
      `  product 0x8c : ${productCode ?? '(none)'}\n` +
      `  SET map 0x9e : ${setMap ?? '(none)'}\n` +
      `  GET map 0x9f : ${getMap ?? '(none)'}\n` +
      `  dimmable     : ${dimmable}\n` +
      `  synchro tone : ${synchroColourTone}`,
    );

    let accessory = this.accessories.get(uuid);
    if (accessory) {
      accessory.context.device = context;
      if (accessory.displayName !== displayName) {
        this.log.info(`Renaming accessory ${accessory.displayName} → ${displayName}`);
        accessory.getService(this.Service.AccessoryInformation)
          ?.updateCharacteristic(this.Characteristic.Name, displayName);
      }
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('Adding new accessory:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = context;
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // Only build the handler once per accessory — the constructor registers HAP controllers that
    // cannot be re-registered on subsequent refresh cycles without throwing.
    const handlerKey = `${ip}:${eoj.toLowerCase()}`;
    if (!this.handlers.has(handlerKey)) {
      const handler = new EchonetLightAccessory(this, accessory);
      this.handlers.set(handlerKey, handler);
      handler.refreshState().catch((err: Error) => this.log.debug(`Initial state fetch error for ${displayName}:`, err.message));
    }
  }
}
