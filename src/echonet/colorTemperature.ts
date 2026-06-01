import {
  CT_KELVIN_KNEE,
  CT_KELVIN_MAX,
  CT_KELVIN_MIN,
  CT_PERCENT_KNEE,
  CT_PERCENT_MAX,
  CT_PERCENT_MIN,
} from '../settings.js';

/**
 * Conversion interface returned by {@link createColourTemperatureCurve}.
 * All methods operate on the brightness percent ↔ HomeKit mireds axis.
 */
export interface ColourTemperatureCurveImpl {
  readonly miredMin: number;
  readonly miredMax: number;
  percentToKelvin(percent: number): number;
  kelvinToPercent(kelvin: number): number;
  percentToMired(percent: number): number;
  miredToPercent(mired: number): number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const miredToKelvin = (mired: number): number => 1_000_000 / mired;
export const kelvinToMired = (kelvin: number): number => 1_000_000 / kelvin;

/**
 * Panasonic Synchro Colour Tone curve — roughly mirrors the lamp's internal algorithm.
 *
 *   - 0 % … 90 %  : convex,  K = 2200 + 500 · (p/90)²   (0 %→2200K, 90 %→2700K)
 *   - 90 % … 100 %: linear,  K = 2700 + (6200 − 2700) · (p − 90)/10   (100 %→6200K)
 */
class SynchroColourToneCurve implements ColourTemperatureCurveImpl {
  readonly miredMin = Math.ceil(kelvinToMired(CT_KELVIN_MAX));   // coolest, ≈ 162
  readonly miredMax = Math.floor(kelvinToMired(CT_KELVIN_MIN));  // warmest, ≈ 454

  percentToKelvin(percent: number): number {
    const p = clamp(percent, CT_PERCENT_MIN, CT_PERCENT_MAX);
    if (p <= CT_PERCENT_KNEE) {
      const ratio = p / CT_PERCENT_KNEE;
      return CT_KELVIN_MIN + (CT_KELVIN_KNEE - CT_KELVIN_MIN) * ratio * ratio;
    }
    const ratio = (p - CT_PERCENT_KNEE) / (CT_PERCENT_MAX - CT_PERCENT_KNEE);
    return CT_KELVIN_KNEE + (CT_KELVIN_MAX - CT_KELVIN_KNEE) * ratio;
  }

  kelvinToPercent(kelvin: number): number {
    const k = clamp(kelvin, CT_KELVIN_MIN, CT_KELVIN_MAX);
    if (k <= CT_KELVIN_KNEE) {
      const ratio = Math.sqrt((k - CT_KELVIN_MIN) / (CT_KELVIN_KNEE - CT_KELVIN_MIN));
      return CT_PERCENT_KNEE * ratio;
    }
    const ratio = (k - CT_KELVIN_KNEE) / (CT_KELVIN_MAX - CT_KELVIN_KNEE);
    return CT_PERCENT_KNEE + (CT_PERCENT_MAX - CT_PERCENT_KNEE) * ratio;
  }

  percentToMired(percent: number): number {
    return clamp(Math.round(kelvinToMired(this.percentToKelvin(percent))), this.miredMin, this.miredMax);
  }

  miredToPercent(mired: number): number {
    return Math.round(this.kelvinToPercent(miredToKelvin(mired)));
  }
}

/** Factory: create the Synchro Colour Tone curve implementation. */
export function createColourTemperatureCurve(): ColourTemperatureCurveImpl {
  return new SynchroColourToneCurve();
}
