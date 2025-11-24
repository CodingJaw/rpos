///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import { RecordingStore, WeeklySchedule } from '../lib/recordingStore';

const utils = Utils.utils;

class Media2Service extends SoapService {
  media2_service: any;
  store: RecordingStore;

  constructor(config: rposConfig, server: Server, store: RecordingStore) {
    super(config, server);

    this.media2_service = require('./stubs/media2_service.js').Media2Service;
    this.store = store;

    this.serviceOptions = {
      path: '/onvif/media2_service',
      services: this.media2_service,
      xml: fs.readFileSync('./wsdl/media2_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/media2_service.wsdl',
      onReady: function () {
        utils.log.info('media2_service started');
      }
    };

    this.extendService();
  }

  extendService() {
    const port = this.media2_service.Media2Service.Media2;

    port.GetRecordingConfiguration = () => {
      return { RecordingConfiguration: this.store.getConfiguration() };
    };

    port.SetRecordingConfiguration = (args) => {
      if (args?.RecordingConfiguration?.Mode) {
        this.store.setMode(args.RecordingConfiguration.Mode);
      }
      if (args?.RecordingConfiguration?.Schedule) {
        this.store.setSchedule(<WeeklySchedule>args.RecordingConfiguration.Schedule);
      }
      return { RecordingConfiguration: this.store.getConfiguration() };
    };

    port.SetRecordingMode = (args) => {
      const mode = this.store.setMode(args?.Mode);
      return { RecordingConfiguration: this.store.getConfiguration(), Mode: mode };
    };

    port.SetRecordingSchedule = (args) => {
      const schedule = this.store.setSchedule(<WeeklySchedule>args?.Schedule);
      return { RecordingConfiguration: this.store.getConfiguration(), Schedule: schedule };
    };

    port.GetServiceCapabilities = () => {
      return {
        Capabilities: {
          attributes: {
            SnapshotUri: false,
            Rotation: false,
            VideoSourceMode: false,
            OSD: false,
            TemporaryOSDText: false,
            Mask: false,
            SourceMask: false
          },
          Extension: {
            Recording: {
              Mode: this.store.getConfiguration().Mode,
              HasSchedule: true
            }
          }
        }
      };
    };
  }
}

export = Media2Service;

