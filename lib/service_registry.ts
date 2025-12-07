import { Utils } from './utils';

export interface ServiceEntry {
  Namespace: string;
  XAddr: string;
  Capabilities?: any;
  Version?: { Major: number; Minor: number };
}

/**
 * Simple registry that collects ONVIF services in a deterministic order so
 * GetServices can always return a complete, stable list.  Entries are de-duplicated
 * by Namespace while preserving insertion order for consistent responses.
 */
export class ServiceRegistry {
  private entries: ServiceEntry[] = [];

  register(entry: ServiceEntry) {
    if (!entry || !entry.Namespace || !entry.XAddr) {
      throw new Error('Service entries must include Namespace and XAddr');
    }

    // Remove any previous entry for the same namespace to avoid stale data.
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].Namespace === entry.Namespace) {
        this.entries.splice(i, 1);
        break;
      }
    }

    this.entries.push(entry);
  }

  getServices(): ServiceEntry[] {
    var clone: ServiceEntry[] = [];
    for (var i = 0; i < this.entries.length; i++) {
      clone.push(this.entries[i]);
    }
    return clone;
  }
}

export function buildXAddr(path: string, config: rposConfig) {
  return "http://" + Utils.utils.getIpAddress() + ":" + config.ServicePort + path;
}
