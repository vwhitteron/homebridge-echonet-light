<span align="center">

# Homebridge ECHONET Light

A [Homebridge](https://homebridge.io/) plugin for controlling [ECHONET Lite](https://echonet.jp/features_en/) lighting devices.

[![npm](https://img.shields.io/npm/dt/homebridge-echonet-light)](https://www.npmjs.com/package/homebridge-echonet-light)  

</span>

## Disclaimer

Homebridge ECHONET Light is independently developed and is not in any way affiliated with or endorsed by the ECHONET Consortium. Any issues
or damage resulting from use of this plugin are not the fault of the developer. Use at your own risk.

## About

Homebridge ECHONET Lite auto-discovers lighting devices on the local network and exposes them in Apple HomeKit with support for the
following device classes:

* General Lighting (class 0x0290)
* Mono-function Lighting (class 0x0291)

## Features

- **Automatic discovery** via ECHONET Lite multicast search (UDP port 3610), with periodic re-discovery to pick up newly powered-on devices.
- **Basic on/off switches** are exposed as a switch, allowing users to present them as a
  Light or Fan accessory type in the Apple Home app.
- **Dimming switches** are exposed as a lightbulb with brightness control, and optionally with a color temperature characteristic (see
  [ Synchro Colour Tone](#synchro-colour-tone)).
- **Live updates**: the plugin subscribes to ECHONET Lite INF (status-change announcement) frames, so changes made from a wall switch or
  another controller appear in HomeKit immediately without polling.

## Configuration

Add a `platforms` entry to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "echonet-light",
      "name": "ECHONET Light",
      "ipVersion": 4,
      "discoveryInterval": 600,
      "pollInterval": 5,
      "synchroColourTone": true,
      "devices": [
        {
          "serialNumber": "0000000000000000000000fe80dead",
          "synchroColourTone": false
        }
      ]
    }
  ]
}
```

### Options

|          Option          |  Type   |      Default      |                              Description                                    |
|--------------------------|---------|-------------------|-----------------------------------------------------------------------------|
| `name`                   | string  | `"ECHONET Light"` | Display name for this platform instance in Homebridge.                      |
| `ipVersion`              | integer | `4`               | IP stack to use. `0` = dual-stack, `4` = IPv4 only, `6` = IPv6 only.        |
| `discoveryInterval`      | integer | `300`             | Seconds between device re-discovery runs. Minimum `10`.                     |
| `pollInterval`           | integer | `5`               | Seconds between periodic state polls for each known device. Minimum `1`.    |
| `synchroColourTone`      | boolean | `false`           | Globally enable colour temperature characteristic for all dimmable devices. |
| `devices`                | array   | `[]`              | Per-device overrides (see below).                                           |

#### Per-device overrides

Each entry in the `devices` array targets a specific device by its serial number. The plugin logs this value on first discovery and it can
also be found under the accessory info panel in the web UI.

|       Option        |  Type   | Req |                          Description                            |
|---------------------|---------|-----|-----------------------------------------------------------------|
| `serialNumber`      | string  | Yes | The device serial number.                                       |
| `synchroColourTone` | boolean | No  | Per-device override for the global `synchroColourTone` setting. |

---

## Synchro Colour Tone

Panasonic offers [synchro colour tone](https://sumai.panasonic.jp/lighting/home/synchro/feature/) lamps that shift colour temperature
directly in relation to the dimmer brightness setting. When `synchroColourTone` is `true`, the plugin exposes a HomeKit color temperature
characteristic directly linked to brightness so when either the temperature or brightness controls are adjust the other moves in unison.
This setting attempts to match the colour temperature and brightness curve that is applied within the lamp so that the colour temperature
can be set and potentially support adaptive lighting in Apple Home.
