/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json.
 * It must match the `pluginAlias` in config.schema.json.
 */
export const PLATFORM_NAME = 'echonet-light';

/**
 * This must match the name of the plugin as defined in package.json `name`.
 */
export const PLUGIN_NAME = 'homebridge-echonet-light';

/**
 * ECHONET Lite class codes (class group + class) for the lighting device objects we support.
 * General lighting supports dimming and (optionally) colour control; mono-function lighting is on/off only.
 */
export const CLASS_GENERAL_LIGHTING = '0290';
export const CLASS_MONO_FUNCTION_LIGHTING = '0291';
export const LIGHTING_CLASSES = [CLASS_GENERAL_LIGHTING, CLASS_MONO_FUNCTION_LIGHTING];

/** The EOJ this plugin presents itself as on the network: a controller (class group 05, class ff). */
export const CONTROLLER_EOJ = '05ff01';

/** ECHONET Lite property codes (EPC), as lower-case 2-char hex strings. */
export const EPC = {
  OPERATION_STATUS: '80',
  ILLUMINANCE_LEVEL: 'b0',
  MAX_SPECIFIABLE_ILLUMINANCE_LEVEL: 'b4',
  IDENTIFICATION_NUMBER: '83',
  MANUFACTURER_CODE: '8a',
  PRODUCT_CODE: '8c',
  PRODUCTION_NUMBER: '8d',
  PRODUCTION_DATE: '8e',
  SPEC_VERSION: '82',
  STATUS_ANNOUNCE_PROPERTY_MAP: '9d',
  SET_PROPERTY_MAP: '9e',
  GET_PROPERTY_MAP: '9f',
} as const;

/** Operation status EDT values. */
export const EDT_ON = '30';
export const EDT_OFF = '31';

/** Illuminance/brightness level is encoded as a single byte 0x00–0x64 (0–100 %). */
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 100;

/** Default interval (seconds) between re-discovery + state refresh polls. */
export const DEFAULT_DISCOVERY_INTERVAL = 300;

/** Default interval (seconds) between periodic state polls for each known device. */
export const DEFAULT_POLL_INTERVAL = 5;

/** Default delay (ms) before the first discovery run after startup. */
export const DEFAULT_INITIAL_SCAN_DELAY_MS = 1000;

/**
 * How long a write takes to settle on the device: the period after we set a value during which the
 * device keeps emitting traffic about it (the trailing SET_RES/INF confirmation, plus any stale or
 * transient reports). Both suppression layers derive their window from this single budget — the
 * client dedups the confirming INF within it, and the accessory ignores incoming updates within it
 * so our just-written value stays authoritative and the sliders don't get yanked.
 */
export const UPDATE_SETTLE_MS = 2500;

/**
 * Colour-temperature curve breakpoints. Colour temperature is a HomeKit-only relationship derived
 * from brightness (the lamp manages its own colour temperature internally); it is not backed by any
 * ECHONET property. Brightness percent → Kelvin: convex from 0–90 %, then linear from 90–100 %.
 */
export const CT_PERCENT_MIN = 0;
export const CT_PERCENT_KNEE = 90;
export const CT_PERCENT_MAX = 100;
export const CT_KELVIN_MIN = 2200;
export const CT_KELVIN_KNEE = 2700;
export const CT_KELVIN_MAX = 6200;

