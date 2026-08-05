interface NavigatorUABrand {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  brands?: NavigatorUABrand[];
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platformVersion?: string;
    architecture?: string;
    bitness?: string;
    model?: string;
    uaFullVersion?: string;
    fullVersionList?: NavigatorUABrand[];
  }>;
}

declare global {
  interface Navigator {
    userAgentData?: NavigatorUAData;
  }
  // mutationCount() installs its counter under a per-process random key, so there
  // is no fixed Window property to declare here.
}

export {};
