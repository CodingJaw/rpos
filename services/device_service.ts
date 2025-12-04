///<reference path="../rpos.d.ts" />

import fs = require("fs");
import util = require("util");
import os = require('os');
import SoapService = require('../lib/SoapService');
import MediaService = require("./media_service");
import EventService = require("./event_service");
import { Utils }  from '../lib/utils';
import { Server } from 'http';
import ip = require('ip');
var utils = Utils.utils;

const NAMESPACE = "http://www.onvif.org/ver10/device/wsdl";
const PATH = '/onvif/device_service';

class DeviceService extends SoapService {
  device_service: any;
  callback: any;
  media_service: MediaService;

  constructor(config: rposConfig, server: Server, media_service: MediaService,callback) {
    super(config, server);

    this.device_service = require('./stubs/device_service.js').DeviceService;
    this.callback = callback;
    this.media_service = media_service;

    this.serviceOptions = {
      path: DeviceService.path,
      services: this.device_service,
      xml: fs.readFileSync('./wsdl/onvif/services/device_service.wsdl', 'utf8'),
      uri: 'wsdl/onvif/services/device_service.wsdl',
      callback: () => console.log('device_service started')
    };

    this.extendService();
  }

  static get namespace() {
    return NAMESPACE;
  }

  static get path() {
    return PATH;
  }

  extendService() {
    var port = this.device_service.DeviceService.Device;

    port.GetDeviceInformation = (args /*, cb, headers*/) => {
      var GetDeviceInformationResponse = {
        Manufacturer: this.config.DeviceInformation.Manufacturer,
        Model: this.config.DeviceInformation.Model,
        FirmwareVersion: this.config.DeviceInformation.FirmwareVersion,
        SerialNumber: this.config.DeviceInformation.SerialNumber,
        HardwareId: this.config.DeviceInformation.HardwareId
      };
      return GetDeviceInformationResponse;
    };

    port.GetSystemDateAndTime = (args /*, cb, headers*/) => {
      var now = new Date();

      // Ideally this code would compute a full POSIX TZ string with daylight saving
      // For now we will compute the current time zone as a UTC offset
      // Note that what we call UTC+ 1 in called UTC-1 in Posix TZ format
      var offset = now.getTimezoneOffset();
      var abs_offset = Math.abs(offset);
      var hrs_offset = Math.floor(abs_offset / 60);
      var mins_offset = (abs_offset % 60);
      var tz = "UTC" + (offset < 0 ? '-' : '+') + hrs_offset + (mins_offset === 0 ? '' : ':' + mins_offset);

      var GetSystemDateAndTimeResponse = {
        SystemDateAndTime: {
          "tt:DateTimeType": "NTP",
          "tt:DaylightSavings": now.dst(),
          "tt:TimeZone": {
            "tt:TZ": tz
          },
          "tt:UTCDateTime": {
            "tt:Time": { "tt:Hour": now.getUTCHours(), "tt:Minute": now.getUTCMinutes(), "tt:Second": now.getUTCSeconds() },
            "tt:Date": { "tt:Year": now.getUTCFullYear(), "tt:Month": now.getUTCMonth() + 1, "tt:Day": now.getUTCDate() }
          },
          "tt:LocalDateTime": {
            "tt:Time": { "tt:Hour": now.getHours(), "tt:Minute": now.getMinutes(), "tt:Second": now.getSeconds() },
            "tt:Date": { "tt:Year": now.getFullYear(), "tt:Month": now.getMonth() + 1, "tt:Day": now.getDate() }
          },
          "tt:Extension": {}
        }
      };
      return GetSystemDateAndTimeResponse;
    };

    port.SetSystemDateAndTime = (args /*, cb, headers*/) => {
      var SetSystemDateAndTimeResponse = {};
      return SetSystemDateAndTimeResponse;
    };

    port.SystemReboot = (args /*, cb, headers*/) => {
      var SystemRebootResponse = {
        Message: utils.execSync("sudo reboot")
      };
      return SystemRebootResponse;
    };

    port.GetServices = (args /*, cb, headers*/) => {
      // ToDo. Check value of args.IncludeCapability
      var GetServicesResponse = {
        Service : [
        {
          Namespace : DeviceService.namespace,
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}${DeviceService.path}`,
          Capabilities : {
            Network : {
              IPFilter : "true",
              ZeroConfiguration : "true",
              IPVersion6 : "true",
              DynDNS : "true",
              Dot11Configuration : "false",
              Dot1XConfigurations : "0",
              HostnameFromDHCP : "true",
              NTP : "1",
              DHCPv6 : "true"
            },
            Security : {
              "TLS1.0" : "true",
              "TLS1.1" : "true",
              "TLS1.2" : "true",
              OnboardKeyGeneration : "false",
              AccessPolicyConfig : "false",
              DefaultAccessPolicy : "true",
              Dot1X : "false",
              RemoteUserHandling : "false",
              "X.509Token" : "false",
              SAMLToken : "false",
              KerberosToken : "false",
              UsernameToken : "true",
              HttpDigest : "true",
              RELToken : "false",
              SupportedEAPMethods : "0",
              MaxUsers : "32",
              MaxUserNameLength : "32",
              MaxPasswordLength : "16"
            },
            System : {
              DiscoveryResolve : "false",
              DiscoveryBye : "true",
              RemoteDiscovery : "false",
              SystemBackup : "false",
              SystemLogging : "true",
              FirmwareUpgrade : "true",
              HttpFirmwareUpgrade : "true",
              HttpSystemBackup : "false",
              HttpSystemLogging : "false",
              HttpSupportInformation : "false",
              StorageConfiguration : "true",
              MaxStorageConfigurations : "8"
            }
          },
          Version : { 
            Major : 18,
            Minor : 12,
          }
        },
        { 
          Namespace : MediaService.namespace,
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}${MediaService.path}`,
          Capabilities : this.media_service.getPort().GetServiceCapabilities(),
          Version : { 
            Major : 2,
            Minor : 60,
          }
        },
        //Events
        {
          Namespace : EventService.namespace,
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}${EventService.path}`,
          Capabilities : {
            WSSubscriptionPolicySupport : "false",
            WSPullPointSupport : "true",
            WSPausableSubscriptionManagerInterfaceSupport : "false"
          },
          Version : {
            Major : 20,
            Minor : 12,
          }
        },
        {
          Namespace : "http://www.onvif.org/ver20/imaging/wsdl",
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/imaging_service`,
          Capabilities : {
            ImageStabilization : "false"
          },
          Version : {
            Major : 16,
            Minor : 6,
          }
        },
        {
          Namespace : "http://www.onvif.org/ver10/deviceIO/wsdl",
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/deviceio_service`,
          Capabilities : {
            VideoSources : "1",
            VideoOutputs : "0",
            AudioSources : "1",
            AudioOutputs : "1",
            RelayOutputs : "4",
            DigitalInputs : "4",
            SerialPorts : "1",
            DigitalInputOptions : "true"
          },
          Version : {
            Major : 16,
            Minor : 12,
          }
        },
        //analytics
        //recording
        //search
        //replay
        //media
        { 
          Namespace : "http://www.onvif.org/ver20/ptz/wsdl",
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/ptz_service`,
          Version : { 
            Major : 2,
            Minor : 5,
          },
        },
        { 
          Namespace : "http://www.onvif.org/ver20/media/wsdl",
          XAddr : `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/media2_service`,
          Capabilities : { 
            SnapshotUri : "true",
            Rotation : "false",
            VideoSourceMode : "false",
            OSD : "true",
            Mask : "true",
            SourceMask : "true"
          },
          Version : { 
            Major : 16,
            Minor : 12,
          }
        }]
      };

      return GetServicesResponse;
    };


    port.GetCapabilities = (args /*, cb, headers*/) => {
      console.log("GetCapabilities : " + JSON.stringify(args))
      var category = args.Category; // Category is Optional and may be undefined
      //{ 'All', 'Analytics', 'Device', 'Events', 'Imaging', 'Media', 'PTZ' }
      var GetCapabilitiesResponse = {
        Capabilities: {}
      };

      if (category === undefined || category == "All" || category == "Device") {
        // var device_caps = this.getPort().GetServiceCapabilities();
        GetCapabilitiesResponse.Capabilities["tt:Device"] = {
          "tt:XAddr": `http://${utils.getIpAddress() }:${this.config.ServicePort}${DeviceService.path}`,
          "tt:Network": {
            "tt:IPFilter": false,
            "tt:ZeroConfiguration": false,
            "tt:IPVersion6": false,
            "tt:DynDNS": false
          },
          "tt:System": {
            "tt:DiscoveryResolve": false,
            "tt:DiscoveryBye": false,
            "tt:RemoteDiscovery": false,
            "tt:SystemBackup": false,
            "tt:SystemLogging": false,
            "tt:FirmwareUpgrade": false,
            "tt:SupportedVersions": {
              "tt:Major": 22,
              "tt:Minor": 12
            },
            "tt:Extension": {
              "tt:HttpFirmwareUpgrade": false,
              "tt:HttpSystemBackup": false,
              "tt:HttpSystemLogging": false,
              "tt:HttpSupportInformation": false
            }
          },
          "tt:IO": {
            "tt:InputConnectors": 4,
            "tt:RelayOutputs": 4,
            "tt:Extension": {
              "tt:Auxiliary": false,
              "tt:AuxiliaryCommands": ""
            }
          },
          "tt:Security": {
            "tt:TLS1.1": false,
            "tt:TLS1.2": false,
            "tt:OnboardKeyGeneration": false,
            "tt:AccessPolicyConfig": false,
            "tt:X.509Token": false,
            "tt:SAMLToken": false,
            "tt:KerberosToken": false,
            "tt:RELToken": false,
            "tt:Extension": {
              "tt:TLS1.0": false,
              "tt:Extension": {
                "tt:Dot1X": false,
                "tt:RemoteUserHandling": false
              }
            }
          },
          "tt:Extension": {}
        };
      }
      if (category == undefined || category == "All" || category == "Events") {
        GetCapabilitiesResponse.Capabilities["tt:Events"] = {
          XAddr: `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/event_service`,
          WSSubscriptionPolicySupport: false,
          WSPullPointSupport: true,
          WSPausableSubscriptionManagerInterfaceSupport: false
        }
      }
      if (category === undefined || category == "All" || category == "Imaging") {
        GetCapabilitiesResponse.Capabilities["tt:Imaging"] = {
          XAddr: `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/imaging_service`
        }
      }
      if (category === undefined || category == "All" || category == "Media") {
        var media_caps = this.media_service.getPort().GetServiceCapabilities();
        GetCapabilitiesResponse.Capabilities["tt:Media"] = {
          "tt:XAddr": `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/media_service`,
          "tt:StreamingCapabilities": {
            "tt:RTPMulticast": media_caps['trt:Capabilities']['trt:StreamingCapabilities'].attributes.RTPMulticast,
            "tt:RTP_TCP": media_caps['trt:Capabilities']['trt:StreamingCapabilities'].attributes.RTP_TCP,
            "tt:RTP_RTSP_TCP": media_caps['trt:Capabilities']['trt:StreamingCapabilities'].attributes.RTP_RTSP_TCP,
            "tt:Extension": {}
          },
          "tt:Extension": {
            "tt:ProfileCapabilities": {
              "tt:MaximumNumberOfProfiles": media_caps['trt:Capabilities']['trt:ProfileCapabilities'].attributes.MaximumNumberOfProfiles
            }
          }
        }
      }
      if (category === undefined || category == "All" || category == "PTZ") {
        GetCapabilitiesResponse.Capabilities["tt:PTZ"] = {
          XAddr: `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/ptz_service`
        }
      }


      if (category === undefined || category == "All" || category == "Extension") {
        GetCapabilitiesResponse.Capabilities["tt:Extension"] = {
          DeviceIO:{
            XAddr: `http://${utils.getIpAddress() }:${this.config.ServicePort}/onvif/deviceio_service`,
            VideoSources:1,
            VideoOutputs:0,
            AudioSources:1,
            AudioOutputs:1,
            RelayOutputs:4,
            DigitalInputs:4
          }
        }
      }

      //console.log("return : " + JSON.stringify(GetCapabilitiesResponse));
      return GetCapabilitiesResponse;
    };

    port.GetHostname = (args /*, cb, headers*/) => {
      var GetHostnameResponse = {
        HostnameInformation: {
          "tt:FromDHCP": false,
          "tt:Name": os.hostname(),
          "tt:Extension": {}
        }
      };
      return GetHostnameResponse;
    };

    port.SetHostname = (args /*, cb, headers*/) => {
      var SetHostnameResponse = {};
      return SetHostnameResponse;
    };

    port.SetHostnameFromDHCP = (args /*, cb, headers*/) => {
      var SetHostnameFromDHCPResponse = {
        RebootNeeded: false
      };
      return SetHostnameFromDHCPResponse;
    };

    port.GetDNS = (args /*, cb, headers*/) => {
      var GetDNSResponse = { 
        DNSInformation : { 
          FromDHCP : true,
          Extension : { }
        }
      
      };
      return GetDNSResponse;
    };

    port.GetScopes = (args) => {
      var GetScopesResponse = {Scopes: []};
      GetScopesResponse.Scopes.push({
          "tt:ScopeDef": "Fixed",
          "tt:ScopeItem": "onvif://www.onvif.org/location/unknow"
      });
      GetScopesResponse.Scopes.push({
        "tt:ScopeDef": "Fixed",
        "tt:ScopeItem": "onvif://www.onvif.org/Profile/T"
      });
      GetScopesResponse.Scopes.push({
        "tt:ScopeDef": "Fixed",
        "tt:ScopeItem": ("onvif://www.onvif.org/hardware/" + this.config.DeviceInformation.Model)
      });
      GetScopesResponse.Scopes.push({
        "tt:ScopeDef": "Fixed",
        "tt:ScopeItem": "onvif://www.onvif.org/Profile/T"
      });
      GetScopesResponse.Scopes.push({
        "tt:ScopeDef": "Fixed",
        "tt:ScopeItem": ("onvif://www.onvif.org/name/" + this.config.DeviceInformation.Manufacturer)
      });

      return GetScopesResponse;
    };


    port.GetDiscoveryMode = (args /*, cb, headers*/) => {
      var GetDiscoveryModeResponse = { 
        DiscoveryMode : true
      };
      return GetDiscoveryModeResponse;
    };
    
    port.GetServiceCapabilities = (args /*, cb, headers*/) => {
      console.log("GetServiceCapabilities : " + JSON.stringify(args));
      var GetServiceCapabilitiesResponse = {
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
              "TLS1.0": false,
              "TLS1.1": false,
              "TLS1.2": false,
              OnboardKeyGeneration: false,
              AccessPolicyConfig: false,
              DefaultAccessPolicy: false,
              Dot1X: false,
              RemoteUserHandling: false,
              "X.509Token": false,
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
          },
          //Misc : { 
          //  attributes : {
          //    AuxiliaryCommands : {tt:StringAttrList}
          //  }
          //}
        }
      };
      return GetServiceCapabilitiesResponse;
    };

    port.GetNTP = (args /*, cb, headers*/) => {
      var GetNTPResponse = { 
        NTPInformation : { 
          FromDHCP : false,
          //NTPFromDHCP : [{ 
          //  Type : { xs:string},
          //  IPv4Address : { xs:token},
          //  IPv6Address : { xs:token},
          //  DNSname : { xs:token},
          //  Extension : { }
          //}],
          NTPManual : [{ 
            Type : "DNS",
            //IPv4Address : { xs:token},
            //IPv6Address : { xs:token},
            DNSname : "pool.ntp.org",
            Extension : { }
          }],
          Extension : { }
         } 
      };
      return GetNTPResponse;
    };

    port.SetNTP = (args /*, cb, headers*/) => {
      var SetNTPResponse = {};
      return SetNTPResponse;
    };

    port.GetNetworkInterfaces = (args /*, cb, headers*/) => {
      var GetNetworkInterfacesResponse = {
        NetworkInterfaces: []
      };
      var nwifs = os.networkInterfaces();
      for (var nwif in nwifs) {
        for (var addr in nwifs[nwif]) {
           if (nwifs[nwif][addr].family === 'IPv4' && nwif !== 'lo0' && nwif !== 'lo') {
            var mac = (nwifs[nwif][addr].mac).replace(/:/g,'-');
            var ipv4_addr = nwifs[nwif][addr].address;
            var netmask = nwifs[nwif][addr].netmask;
            var prefix_len = ip.subnet(ipv4_addr,netmask).subnetMaskLength;
            GetNetworkInterfacesResponse.NetworkInterfaces.push({
              attributes: {
                token: nwif
              },
              Enabled: true,
              "tt:Info": {
                "tt:Name": nwif,
                "tt:HwAddress": mac,
                "tt:MTU": 1500
              },
              IPv4: {
                Enabled: true,
                Config: {
                   Manual: {
                     Address: ipv4_addr,
                     PrefixLength: prefix_len
                   },
                   DHCP: false
                }
              }
            });
          }
        }
      }
      return GetNetworkInterfacesResponse;
    };

    port.GetNetworkProtocols = (args /*, cb, headers*/) => {
      var GetNetworkProtocolsResponse = {
        NetworkProtocols: [{
          Name: "RTSP",
          Enabled: true,
          Port: this.config.RTSPPort
        }]
      };
      return GetNetworkProtocolsResponse;
    };

    port.GetNetworkDefaultGateway = (args /*, cb, headers*/) => {
      let GetNetworkDefaultGatewayResponse = {}
        if (utils.isLinux) {
        // Linux method for now. Need to include Windows and Mac
        const spawn = require('child_process').spawnSync;

        const child = spawn('bash', ['-c', 'ip route']).stdout.toString();
        const gateway = child.match(/default via (.*?)\s/)[1]; // Look for text "default via " and then get everything up to the next Space or Tab
        GetNetworkDefaultGatewayResponse = { 
          NetworkGateway : { 
            IPv4Address : [gateway], // FIXME. Need to ask the OS for this information
          //IPv6Address : [{ xs:token}]
          }
        };
      } else {
        // TODO
        // return empty result
      }
      return GetNetworkDefaultGatewayResponse;
    };

    port.GetRelayOutputs = (args /*, cb, headers*/) => {
      console.log("GetRelayOutputs : " + JSON.stringify(args));
      var GetRelayOutputsResponse = {
        RelayOutputs: [{
          attributes: {
            token: "relay1"
          },
          Properties : {
            Mode: "Bistable",
            // DelayTime: "",
            IdleState: "open"
          }
        }]
      };
      return GetRelayOutputsResponse;
    };

    port.SetRelayOutputState = (args /*, cb, headers*/) => {
      var SetRelayOutputStateResponse = {};
      if (this.callback) {
        if (args.LogicalState === 'active') this.callback('relayactive', { name: args.RelayOutputToken });
        if (args.LogicalState === 'inactive') this.callback('relayinactive', { name: args.RelayOutputToken });
      }
      return SetRelayOutputStateResponse;
    };

    port.GetUsers = (args /*, cb, headers*/) => {
      var GetUsersResponse = {
//        User : [{
//          Username : '',
//          Password : '',
//          UserLevel : 'Administrator',
//        }]
      };
      return GetUsersResponse;
    };

    port.GetDiscoveryMode = (args /*, cb, headers*/) => {
      var GetDiscoveryModeResponse = { 
        DiscoveryMode : true
      };
      return GetDiscoveryModeResponse;
    };

    port.GetDNS = (args /*, cb, headers*/) => {
      var GetDNSResponse = { 
        DNSInformation : { 
          FromDHCP : true,
          Extension : { }
        }

      };
      return GetDNSResponse;
    };

    port.GetNetworkDefaultGateway = (args /*, cb, headers*/) => {
      let GetNetworkDefaultGatewayResponse = {}
        if (utils.isLinux) {
        // Linux method for now. Need to include Windows and Mac
        const spawn = require('child_process').spawnSync;

        const child = spawn('bash', ['-c', 'ip route']).stdout.toString();
        const gateway = child.match(/default via (.*?)\s/)[1]; // Look for text "default via " and then get everything up to the next Space or Tab
        GetNetworkDefaultGatewayResponse = { 
          NetworkGateway : { 
            IPv4Address : [gateway], // FIXME. Need to ask the OS for this information
          //IPv6Address : [{ xs:token}]
          }
        };
      } else {
        // TODO
        // return empty result
      }
      return GetNetworkDefaultGatewayResponse;
    };

    port.GetCertificates = (args /*, cb, headers*/) => {
      var GetCertificatesResponse = { 
        //NvtCertificate : [{ 
          //CertificateID : { xs:token},
          //Certificate : { 
            //attributes : {
              //undefined : {}
            //},
            //Data : { xs:base64Binary}
          //}
        //}]
      //
      };
      return GetCertificatesResponse;
    };

    port.GetCertificatesStatus = (args /*, cb, headers*/) => {
      var GetCertificatesStatusResponse = { 
        //CertificateStatus : [{ 
          //CertificateID : { xs:token},
          //Status : { xs:boolean}
        //}]
      //
      };
      return GetCertificatesStatusResponse;
    };
  }
}
export = DeviceService;
