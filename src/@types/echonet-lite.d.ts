declare module 'echonet-lite' {
  import type { RemoteInfo } from 'node:dgram';

  /** A parsed ECHONET Lite frame (ELDATA). EPC→EDT pairs live in `DETAILs` as lower-case hex strings. */
  export interface ELDATA {
    EHD: string;
    TID: string;
    SEOJ: string;
    DEOJ: string;
    EDATA: string;
    ESV: string;
    OPC: string;
    DETAIL: string;
    DETAILs: Record<string, string>;
  }

  /** Discovered network state: facilities[ip][eoj][epc] = EDT hex string. */
  export type Facilities = Record<string, Record<string, Record<string, string>>>;

  export type UserFunc = (rinfo: RemoteInfo, els: ELDATA | null, err: Error | null) => void;

  export interface InitializeOptions {
    v4?: string;
    v6?: string;
    ignoreMe?: boolean;
    autoGetProperties?: boolean;
    autoGetDelay?: number;
    debugMode?: boolean;
  }

  /**
   * The `echonet-lite` package is CommonJS (`module.exports = EL`), so it must be consumed via a
   * default import. ESV codes are exposed as hex-string constants on the same object.
   */
  interface EchonetLite {
    // ESV constants (hex strings).
    readonly SETI: string;
    readonly SETC: string;
    readonly GET: string;
    readonly INF_REQ: string;
    readonly SETGET: string;
    readonly SET_RES: string;
    readonly GET_RES: string;
    readonly INF: string;
    readonly INFC: string;
    readonly EL_port: number;

    facilities: Facilities;

    initialize(objList: string[], userfunc: UserFunc, ipVer?: number, options?: InitializeOptions): unknown;
    release(): void;
    search(): void;
    sendOPC1(
      ip: string,
      seoj: string | number[],
      deoj: string | number[],
      esv: string | number,
      epc: string | number,
      edt: string | number | number[],
    ): Buffer;
    getPropertyMaps(ip: string, eoj: string | number[]): void;
    setObserveFacilities(interval: number, onChanged: () => void): void;
    clearObserveFacilities(): void;
    toHexArray(value: string): number[];
    bytesToString(bytes: number[] | string): string;
  }

  const EL: EchonetLite;
  export default EL;
}
