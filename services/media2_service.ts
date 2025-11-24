///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import { RecordingConfigStore, RecordingMode } from '../lib/recordingStore';

const utils = Utils.utils;

class Media2Service extends SoapService {
  private media2_service: any;
  private store: RecordingConfigStore;

  constructor(config: rposConfig, server: Server, store: RecordingConfigStore) {
    super(config, server);
    this.media2_service = require('./stubs/media2_service.js').Media2Service;
    this.store = store;

    this.serviceOptions = {
      path: '/onvif/media2_service',
      services: this.media2_service,
      xml: fs.readFileSync('./wsdl/media2_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/media2_service.wsdl',
      onReady: () => utils.log.info('media2_service started')
    };

    this.extendService();
  }

  private extendService() {
    const port = this.media2_service.Media2Service.Media2;

    port.GetServiceCapabilities = () => ({
      Capabilities: {
        attributes: { xmlns: 'http://www.onvif.org/ver20/media/wsdl' },
        SnapshotUri: true,
        Rotation: false,
        ProfileCapabilities: {
          attributes: { MaximumNumberOfProfiles: 1 },
        },
        Extension: {
          Recording: {
            Modes: this.store.getSupportedModes(),
            SupportsSchedules: true,
          }
        }
      }
    });

    port.GetRecordingMode = () => ({ Mode: this.store.getMode() });

    port.SetRecordingMode = (args: any) => {
      const requested = args?.Mode ?? args?.RecordingMode ?? args;
      const mode = this.store.setMode(requested as RecordingMode);
      return { Mode: mode };
    };

    port.GetRecordingSchedule = () => ({
      Schedule: {
        Entry: this.store.getSchedule()
      }
    });

    port.SetRecordingSchedule = (args: any) => {
      const schedule = this.store.setSchedule(args?.Schedule ?? args);
      return { Schedule: { Entry: schedule } };
    };
  }
}

export = Media2Service;

