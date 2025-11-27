const os = require('os');
const ip = require('ip');
const { Utils } = require('../../lib/utils');
const utils = Utils.utils;

function buildService(config, callback) {
  return {
    DeviceService: {
      Device: {
        GetDeviceInformation() {
          return {
            Manufacturer: config.DeviceInformation.Manufacturer,
            Model: config.DeviceInformation.Model,
            FirmwareVersion: config.DeviceInformation.FirmwareVersion,
            SerialNumber: config.DeviceInformation.SerialNumber,
            HardwareId: config.DeviceInformation.HardwareId
          };
        },

        GetSystemDateAndTime() {
          const now = new Date();
          const offset = now.getTimezoneOffset();
          const absOffset = Math.abs(offset);
          const hrsOffset = Math.floor(absOffset / 60);
          const minsOffset = absOffset % 60;
          const tz =
            'UTC' + (offset < 0 ? '-' : '+') + hrsOffset + (minsOffset === 0 ? '' : ':' + minsOffset);

          return {
            SystemDateAndTime: {
              DateTimeType: 'NTP',
              DaylightSavings: now.dst(),
              TimeZone: { TZ: tz },
              UTCDateTime: {
                Time: { Hour: now.getUTCHours(), Minute: now.getUTCMinutes(), Second: now.getUTCSeconds() },
                Date: {
                  Year: now.getUTCFullYear(),
                  Month: now.getUTCMonth() + 1,
                  Day: now.getUTCDate()
                }
              },
              LocalDateTime: {
                Time: { Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() },
                Date: { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate() }
              },
              Extension: {}
            }
          };
        },

        SetSystemDateAndTime() {
          return {};
        },

        SystemReboot() {
          return {
            Message: utils.execSync('sudo reboot')
          };
        },

        GetServices(args) {
          return {
            Service: [
              {
                Namespace: 'http://www.onvif.org/ver10/device/wsdl',
                XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/device_service`,
                Version: { Major: 2, Minor: 5 }
              },
              {
                Namespace: 'http://www.onvif.org/ver20/imaging/wsdl',
                XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/imaging_service`,
                Version: { Major: 2, Minor: 5 }
              },
              {
                Namespace: 'http://www.onvif.org/ver10/media/wsdl',
                XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/media_service`,
                Version: { Major: 2, Minor: 5 }
              },
              {
                Namespace: 'http://www.onvif.org/ver20/ptz/wsdl',
                XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/ptz_service`,
                Version: { Major: 2, Minor: 5 }
              }
            ]
          };
        },

        GetCapabilities(args) {
          const category = args && args.Category;
          const response = { Capabilities: {} };

          if (category === undefined || category === 'All' || category === 'Device') {
            response.Capabilities.Device = {
              XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/device_service`,
              Network: {
                IPFilter: false,
                ZeroConfiguration: false,
                IPVersion6: false,
                DynDNS: false,
                Extension: { Dot11Configuration: false, Extension: {} }
              },
              System: {
                DiscoveryResolve: false,
                DiscoveryBye: false,
                RemoteDiscovery: false,
                SystemBackup: false,
                SystemLogging: false,
                FirmwareUpgrade: false,
                SupportedVersions: { Major: 2, Minor: 5 },
                Extension: {
                  HttpFirmwareUpgrade: false,
                  HttpSystemBackup: false,
                  HttpSystemLogging: false,
                  HttpSupportInformation: false,
                  Extension: {}
                }
              },
              IO: {
                InputConnectors: 0,
                RelayOutputs: 1,
                Extension: { Auxiliary: false, AuxiliaryCommands: '', Extension: {} }
              },
              Security: {
                'TLS1.1': false,
                'TLS1.2': false,
                OnboardKeyGeneration: false,
                AccessPolicyConfig: false,
                'X.509Token': false,
                SAMLToken: false,
                KerberosToken: false,
                RELToken: false,
                Extension: { 'TLS1.0': false, Extension: { Dot1X: false, RemoteUserHandling: false } }
              },
              Extension: {}
            };
          }

          if (category === undefined || category === 'All' || category === 'Events') {
            response.Capabilities.Events = {
              XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/events_service`,
              WSSubscriptionPolicySupport: false,
              WSPullPointSupport: false,
              WSPausableSubscriptionManagerInterfaceSupport: false
            };
          }

          if (category === undefined || category === 'All' || category === 'Imaging') {
            response.Capabilities.Imaging = {
              XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/imaging_service`
            };
          }

          if (category === undefined || category === 'All' || category === 'Media') {
            response.Capabilities.Media = {
              XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/media_service`,
              StreamingCapabilities: {
                RTPMulticast: config.MulticastEnabled,
                RTP_TCP: true,
                RTP_RTSP_TCP: true,
                Extension: {}
              },
              Extension: {
                ProfileCapabilities: {
                  MaximumNumberOfProfiles: 1
                }
              }
            };
          }

          if (category === undefined || category === 'All' || category === 'PTZ') {
            response.Capabilities.PTZ = {
              XAddr: `http://${utils.getIpAddress()}:${config.ServicePort}/onvif/ptz_service`
            };
          }

          return response;
        },

        GetHostname() {
          return {
            HostnameInformation: {
              FromDHCP: false,
              Name: os.hostname(),
              Extension: {}
            }
          };
        },

        SetHostname() { return {}; },

        SetHostnameFromDHCP() {
          return { RebootNeeded: false };
        },

        GetDNS() {
          return {
            DNSInformation: { FromDHCP: true, Extension: {} }
          };
        },

        GetScopes() {
          const scopes = [];
          scopes.push({ ScopeDef: 'Fixed', ScopeItem: 'onvif://www.onvif.org/location/unknow' });
          scopes.push({ ScopeDef: 'Fixed', ScopeItem: `onvif://www.onvif.org/hardware/${config.DeviceInformation.Model}` });
          scopes.push({ ScopeDef: 'Fixed', ScopeItem: `onvif://www.onvif.org/name/${config.DeviceInformation.Manufacturer}` });
          return { Scopes: scopes };
        },

        GetDiscoveryMode() {
          return { DiscoveryMode: true };
        },

        GetServiceCapabilities() {
          return {
            Capabilities: {
              Network: {
                attributes: {
                  IPFilter: false,
                  ZeroConfiguration: false,
                  IPVersion6: false,
                  DynDNS: false,
                  Dot11Configuration: false,
                  Dot1XConfigurations: 0,
                  HostnameFromDHCP: false,
                  NTP: 0,
                  DHCPv6: false
                }
              },
              Security: {
                attributes: {
                  'TLS1.0': false,
                  'TLS1.1': false,
                  'TLS1.2': false,
                  OnboardKeyGeneration: false,
                  AccessPolicyConfig: false,
                  DefaultAccessPolicy: false,
                  Dot1X: false,
                  RemoteUserHandling: false,
                  'X.509Token': false,
                  SAMLToken: false,
                  KerberosToken: false,
                  UsernameToken: false,
                  HttpDigest: false,
                  RELToken: false,
                  SupportedEAPMethods: 0,
                  MaxUsers: 1,
                  MaxUserNameLength: 10,
                  MaxPasswordLength: 256
                }
              },
              System: {
                attributes: {
                  DiscoveryResolve: false,
                  DiscoveryBye: false,
                  RemoteDiscovery: false,
                  SystemBackup: false,
                  SystemLogging: false,
                  FirmwareUpgrade: false,
                  HttpFirmwareUpgrade: false,
                  HttpSystemBackup: false,
                  HttpSystemLogging: false,
                  HttpSupportInformation: false,
                  StorageConfiguration: false
                }
              }
            }
          };
        },

        GetNTP() {
          return {
            NTPInformation: {
              FromDHCP: false,
              NTPManual: [
                {
                  Type: 'DNS',
                  DNSname: 'pool.ntp.org',
                  Extension: {}
                }
              ],
              Extension: {}
            }
          };
        },

        SetNTP() { return {}; },

        GetNetworkInterfaces() {
          const response = { NetworkInterfaces: [] };
          const nwifs = os.networkInterfaces();
          for (const nwif in nwifs) {
            for (const addr of nwifs[nwif]) {
              if (addr.family === 'IPv4' && nwif !== 'lo0' && nwif !== 'lo') {
                const mac = addr.mac.replace(/:/g, '-');
                const ipv4Addr = addr.address;
                const netmask = addr.netmask;
                const prefixLen = ip.subnet(ipv4Addr, netmask).subnetMaskLength;
                response.NetworkInterfaces.push({
                  attributes: { token: nwif },
                  Enabled: true,
                  Info: { Name: nwif, HwAddress: mac, MTU: 1500 },
                  IPv4: {
                    Enabled: true,
                    Config: {
                      Manual: { Address: ipv4Addr, PrefixLength: prefixLen },
                      DHCP: false
                    }
                  }
                });
              }
            }
          }
          return response;
        },

        GetNetworkProtocols() {
          return {
            NetworkProtocols: [
              {
                Name: 'RTSP',
                Enabled: true,
                Port: config.RTSPPort
              }
            ]
          };
        },

        GetNetworkDefaultGateway() {
          let response = {};
          if (utils.isLinux) {
            const spawn = require('child_process').spawnSync;
            const child = spawn('bash', ['-c', 'ip route']).stdout.toString();
            const gateway = child.match(/default via (.*?)\s/)[1];
            response = {
              NetworkGateway: {
                IPv4Address: [gateway]
              }
            };
          }
          return response;
        },

        GetRelayOutputs() {
          return {
            RelayOutputs: [
              {
                attributes: { token: 'relay1' },
                Properties: {
                  Mode: 'Bistable',
                  IdleState: 'open'
                }
              }
            ]
          };
        },

        SetRelayOutputState(args) {
          if (callback) {
            if (args.LogicalState === 'active') callback('relayactive', { name: args.RelayOutputToken });
            if (args.LogicalState === 'inactive') callback('relayinactive', { name: args.RelayOutputToken });
          }
          return {};
        },

        GetUsers() {
          return {};
        }
      }
    }
  };
}

module.exports = (config, callback) => buildService(config, callback);
module.exports.DeviceService = (config, callback) => buildService(config, callback);
