///<reference path="../rpos.d.ts" />

import fs = require("fs");
import util = require("util");
import SoapService = require('../lib/SoapService');
import { Utils }  from '../lib/utils';
import url = require('url');
import { Server } from 'http';
import Camera = require('../lib/camera');
import { v4l2ctl } from '../lib/v4l2ctl';
import { exec } from 'child_process';
import PTZService = require('./ptz_service');
var utils = Utils.utils;

const NAMESPACE = "http://www.onvif.org/ver10/media/wsdl";
const PATH = '/onvif/media_service';

class MediaService extends SoapService {
  media_service: any;
  camera: Camera;
  ptz_service: PTZService;
  ffmpeg_process: any = null;
  ffmpeg_responses: any[] = [];

  constructor(config: rposConfig, server: Server, camera: Camera, ptz_service: PTZService) {
    super(config, server);
    this.init(config,server,camera,ptz_service);
  }

  init(config: rposConfig, server: Server, camera: Camera, ptz_service: PTZService) {
    this.media_service = require('./stubs/media_service.js').MediaService;

    this.camera = camera;
    this.ptz_service = ptz_service;
    this.serviceOptions = {
      path: PATH,
      services: this.media_service,
      xml: fs.readFileSync('./wsdl/onvif/services/media_service.wsdl', 'utf8'),
      uri: 'wsdl/onvif/services/media_service.wsdl',
      callback: function() {
        utils.log.info('media_service started');
      }
    };
    
    this.extendService();
  }

  static get namespace() {
    return NAMESPACE;
  }

  static get path() {
    return PATH;
  }

  getPort() {
    return this.media_service.MediaService.Media;
  }
  
  starting() {
    var listeners = this.webserver.listeners('request').slice();
    this.webserver.removeAllListeners('request');
    this.webserver.addListener('request', (request, response, next) => {
      utils.log.debug('web request received : %s', request.url);

      var uri = url.parse(request.url, true);
      var action = uri.pathname;
      if (action == '/web/snapshot.jpg') {
        try {
          if (this.ffmpeg_process != null) {
            utils.log.info("ffmpeg - already running");
            this.ffmpeg_responses.push(response);
          } else {
            var cmd;
            if(this.config.RTSPServer == 3){ //If gstreamer is used, leverage the custom python launcher using shared libs (Faster than ffmpeg) 
              cmd = `/usr/bin/python3 python/gst-rtsp-snapshot.py -v -u rtsp://127.0.0.1:${this.config.RTSPPort}/${this.config.RTSPName} -o /dev/shm/snapshot.jpg`
            } else if(this.config.RTSPServer == 4){ //If onvifserver is used, use embedded screenshot feature to reduce dependencies
              cmd = `./subprojects/OnvifRtspLauncher/build/onvifserver -s rtspt://127.0.0.1:${this.config.RTSPPort}/${this.config.RTSPName} -o /dev/shm/snapshot.jpg`
            } else { //Use rpos default.
              cmd = `ffmpeg -fflags nobuffer -probesize 256 -rtsp_transport tcp -i rtsp://127.0.0.1:${this.config.RTSPPort}/${this.config.RTSPName} -vframes 1  -r 1 -s 640x360 -y /dev/shm/snapshot.jpg`;
            }

            var options = { timeout: 15000 };
            utils.log.info("Snapshot - starting - " + cmd);
            this.ffmpeg_responses.push(response);
            this.ffmpeg_process = exec(cmd, options, (error, stdout, stderr) => {
              // callback
              utils.log.info("Snapshot - finished");
              if (error) {
                utils.log.warn('Snapshot exec error: %s', error);
              }
              // deliver the JPEG (or the logo jpeg file)
              for (let responseItem of this.ffmpeg_responses) {
                this.deliver_jpg(responseItem); // response.Write() and response.End()
              }
              // empty the list of responses
              this.ffmpeg_responses = [];
              this.ffmpeg_process = null;
            });
          }
        } catch (err) {
          utils.log.warn('Error ' + err);
        }
      } else {
        for (var i = 0, len = listeners.length; i < len; i++) {
          listeners[i].call(this, request, response, next);
        }
      }
    });
  }

  deliver_jpg(response: any){
    try {
      var img = fs.readFileSync('/dev/shm/snapshot.jpg');
      response.writeHead(200, { 'Content-Type': 'image/jpg' });
      response.end(img, 'binary');
      return;
    } catch (err) {
      utils.log.debug("Error opening snapshot : %s", err);
    }
    try {
      var img = fs.readFileSync('./web/snapshot.jpg');
      response.writeHead(200, { 'Content-Type': 'image/jpg' });
      response.end(img, 'binary');
      return;
    } catch (err) {
      utils.log.debug("Error opening snapshot : %s", err);
    }

    // Return 400 error
    response.writeHead(400, { 'Content-Type': 'text/plain' });
    response.end('JPEG unavailable');
  }

  started() {
    utils.log.debug("Media starting rtsp server");
    this.camera.startRtsp();
  }

  extendService() {
    var port = this.getPort();

    var cameraOptions = this.camera.options;
    var cameraSettings = this.camera.settings;
    var camera = this.camera;

    var h264Profiles = v4l2ctl.Controls.CodecControls.h264_profile.getLookupSet().map(ls=>ls.desc);
    h264Profiles.splice(1, 1);
    
    var videoConfigurationOptions = {  
      //attributes : {
        //GuaranteedFrameRateSupported : {xs:boolean}
      //},
      QualityRange: {
        Min: 1,
        Max: 1
      },
      JPEG : { 
        ResolutionsAvailable: cameraOptions.resolutions,
        FrameRateRange: {
          Min: cameraOptions.framerates[0],
          Max: cameraOptions.framerates[cameraOptions.framerates.length - 1]
        },
        EncodingIntervalRange: { Min: 1, Max: 1 },
      },
      //MPEG4 : { 
        //ResolutionsAvailable : { 
          //Width : { xs:int},
          //Height : { xs:int}
        //},
        //GovLengthRange : { 
          //Min : { xs:int},
          //Max : { xs:int}
        //},
        //FrameRateRange : { 
          //Min : { xs:int},
          //Max : { xs:int}
        //},
        //EncodingIntervalRange : { 
          //Min : { xs:int},
          //Max : { xs:int}
        //},
        //Mpeg4ProfilesSupported : { xs:string}
      //},
      H264: {
        ResolutionsAvailable: cameraOptions.resolutions,
        GovLengthRange: {
          Min: v4l2ctl.Controls.CodecControls.h264_i_frame_period.getRange().min,
          Max: v4l2ctl.Controls.CodecControls.h264_i_frame_period.getRange().max
        },
        FrameRateRange: {
          Min: cameraOptions.framerates[0],
          Max: cameraOptions.framerates[cameraOptions.framerates.length - 1]
        },
        EncodingIntervalRange: { Min: 1, Max: 1 },
        H264ProfilesSupported: h264Profiles,
      },
      Extension: {
        JPEG : { 
          ResolutionsAvailable: cameraOptions.resolutions,
          FrameRateRange: {
            Min: cameraOptions.framerates[0],
            Max: cameraOptions.framerates[cameraOptions.framerates.length - 1]
          },
          EncodingIntervalRange: { Min: 1, Max: 1 },
          BitrateRange: {
            Min: cameraOptions.bitrates[0],
            Max: cameraOptions.bitrates[cameraOptions.bitrates.length - 1]
          }
        },
        //MPEG4 : { 
          //ResolutionsAvailable : { 
            //Width : { xs:int},
            //Height : { xs:int}
          //},
          //GovLengthRange : { 
            //Min : { xs:int},
            //Max : { xs:int}
          //},
          //FrameRateRange : { 
            //Min : { xs:int},
            //Max : { xs:int}
          //},
          //EncodingIntervalRange : { 
            //Min : { xs:int},
            //Max : { xs:int}
          //},
          //Mpeg4ProfilesSupported : { xs:string}
        //
          //BitrateRange : { 
            //Min : { xs:int},
            //Max : { xs:int}
          //}
        //},
        H264 : { 
          ResolutionsAvailable: cameraOptions.resolutions,
          GovLengthRange: {
            Min: v4l2ctl.Controls.CodecControls.h264_i_frame_period.getRange().min,
            Max: v4l2ctl.Controls.CodecControls.h264_i_frame_period.getRange().max
          },
          FrameRateRange: {
            Min: cameraOptions.framerates[0],
            Max: cameraOptions.framerates[cameraOptions.framerates.length - 1]
          },
          EncodingIntervalRange: { Min: 1, Max: 1 },
          H264ProfilesSupported: h264Profiles,
          BitrateRange: {
            Min: cameraOptions.bitrates[0],
            Max: cameraOptions.bitrates[cameraOptions.bitrates.length - 1]
          }
        }
      }
    };

    var videoEncoderConfiguration = {
      attributes: {
        token: "encoder_config_token",
        GuaranteedFrameRate: "false"
      },
      Name: "PiCameraConfiguration",
      UseCount: 0,
      Encoding: "H264",
      Resolution: {
        Width: cameraSettings.resolution.Width,
        Height: cameraSettings.resolution.Height
      },
      Quality: v4l2ctl.Controls.CodecControls.video_bitrate.value ? 1 : 1,
      RateControl: {
        FrameRateLimit: cameraSettings.framerate,
        EncodingInterval: 1,
        BitrateLimit: v4l2ctl.Controls.CodecControls.video_bitrate.value / 1000
      },
      //MPEG4 : { 
        //GovLength : { xs:int},
        //Mpeg4Profile : { xs:string}
      //},
      H264: {
        "tt:GovLength": v4l2ctl.Controls.CodecControls.h264_i_frame_period.value,
        "tt:H264Profile": v4l2ctl.Controls.CodecControls.h264_profile.desc
      },
      Multicast: {
        "tt:Address": {
          "tt:Type": "IPv4",
          IPv4Address: "0.0.0.0"
          //IPv6Address : { xs:token}
        },
        Port: 0,
        TTL:  1,
        AutoStart: false
      },
      SessionTimeout: "PT1000S"
    };

    var videoSource = { 
      attributes : {
        token: "video_src_token"
      },
      Framerate : 25,
      Resolution : { 
        Width : 1920,
        Height : 1280
      },
      //Imaging : { 
        //BacklightCompensation : { 
          //Mode : { xs:string},
          //Level : { xs:float}
        //},
        //Brightness : { xs:float},
        //ColorSaturation : { xs:float},
        //Contrast : { xs:float},
        //Exposure : { 
          //Mode : { xs:string},
          //Priority : { xs:string},
          //Window : { 
            //attributes : {
              //bottom : {xs:float},
              //top : {xs:float},
              //right : {xs:float},
              //left : {xs:float}
            //}
          //},
          //MinExposureTime : { xs:float},
          //MaxExposureTime : { xs:float},
          //MinGain : { xs:float},
          //MaxGain : { xs:float},
          //MinIris : { xs:float},
          //MaxIris : { xs:float},
          //ExposureTime : { xs:float},
          //Gain : { xs:float},
          //Iris : { xs:float}
        //},
        //Focus : { 
          //AutoFocusMode : { xs:string},
          //DefaultSpeed : { xs:float},
          //NearLimit : { xs:float},
          //FarLimit : { xs:float}
        //},
        //IrCutFilter : { xs:string},
        //Sharpness : { xs:float},
        //WideDynamicRange : { 
          //Mode : { xs:string},
          //Level : { xs:float}
        //},
        //WhiteBalance : { 
          //Mode : { xs:string},
          //CrGain : { xs:float},
          //CbGain : { xs:float}
        //},
        //Extension : { }
      //},
      //Extension : { 
        //Imaging : { 
          //BacklightCompensation : { 
            //Mode : { xs:string},
            //Level : { xs:float}
          //},
          //Brightness : { xs:float},
          //ColorSaturation : { xs:float},
          //Contrast : { xs:float},
          //Exposure : { 
            //Mode : { xs:string},
            //Priority : { xs:string},
            //Window : { 
              //attributes : {
                //bottom : {xs:float},
                //top : {xs:float},
                //right : {xs:float},
                //left : {xs:float}
              //}
            //},
            //MinExposureTime : { xs:float},
            //MaxExposureTime : { xs:float},
            //MinGain : { xs:float},
            //MaxGain : { xs:float},
            //MinIris : { xs:float},
            //MaxIris : { xs:float},
            //ExposureTime : { xs:float},
            //Gain : { xs:float},
            //Iris : { xs:float}
          //},
          //Focus : { 
            //attributes : {
              //AFMode : {tt:StringAttrList}
            //},
            //AutoFocusMode : { xs:string},
            //DefaultSpeed : { xs:float},
            //NearLimit : { xs:float},
            //FarLimit : { xs:float},
            //Extension : { }
          //},
          //IrCutFilter : { xs:string},
          //Sharpness : { xs:float},
          //WideDynamicRange : { 
            //Mode : { xs:string},
            //Level : { xs:float}
          //},
          //WhiteBalance : { 
            //Mode : { xs:string},
            //CrGain : { xs:float},
            //CbGain : { xs:float},
            //Extension : { }
          //},
          //Extension : { 
            //ImageStabilization : { 
              //Mode : { xs:string},
              //Level : { xs:float},
              //Extension : { }
            //},
            //Extension : { 
              //IrCutFilterAutoAdjustment : [{ 
                //BoundaryType : { xs:string},
                //BoundaryOffset : { xs:float},
                //ResponseTime : { xs:duration},
                //Extension : { }
              //}],
              //Extension : { 
                //ToneCompensation : { 
                  //Mode : { xs:string},
                  //Level : { xs:float},
                  //Extension : { }
                //},
                //Defogging : { 
                  //Mode : { xs:string},
                  //Level : { xs:float},
                  //Extension : { }
                //},
                //NoiseReduction : { 
                  //Level : { xs:float}
                //},
                //Extension : { }
              //}
            //}
          //}
        //},
        //Extension : { }
      //}
    };

    var videoSourceConfiguration = { 
      attributes: {
        token: "video_src_config_token"
      },
      Name: "Primary Source",
      UseCount: 0,
      //attributes : {
        //ViewMode : {xs:string}
      //},
      SourceToken: "video_src_token",
      Bounds: { attributes: { x: 0, y: 0, width: 1920, height: 1280 } }
      //Extension : { 
        //Rotate : { 
          //Mode : { xs:string},
          //Degree : { xs:int},
          //Extension : { }
        //},
        //Extension : { 
          //LensDescription : [{ 
            //attributes : {
              //FocalLength : {xs:float}
            //},
            //Offset : { 
              //attributes : {
                //x : {xs:float},
                //y : {xs:float}
              //}
            //},
            //Projection : { 
              //Angle : { xs:float},
              //Radius : { xs:float},
              //Transmittance : { xs:float}
            //},
            //XFactor : { xs:float}
          //}],
          //SceneOrientation : [{ 
            //Mode : { xs:string},
            //Orientation : { xs:string}
          //}]
        //}
      //}
    }

    var audioSource = {
      attributes: {
        token: "audio_src_token"
      },
      Channels: 1
    };

    var audioSourceConfiguration = {
      Name: "Primary Audio Source",
      UseCount: 0,
      attributes: {
          token: "audio_src_config_token"
      },
      SourceToken: "audio_src_token"
    }

    var audioEncoderConfigurationOption = {
      Encoding: "AAC",
      Multicast: {
        Address: {
          "tt:Type": "IPv4",
          IPv4Address: "0.0.0.0"
        },
        Port: 0,
        TTL:  1,
        AutoStart: false
      },
      SampleRate: 48000,
      SessionTimeout: "PT1000S"
    };

    var audioOutputConfiguration = {
      Name: "Primary Audio Output",
      UseCount: 0,
      attributes: {
        token: "audio_out_config_token"
      },
      OutputToken: 'audio_out_token',
      OutputLevel: 50
    }

    var audioDecoderConfiguration = {
      Name: "Primary Audio Output Decoder",
      UseCount: 0,
      attributes: {
        token: "audio_out_dec_config_token"
      }
    }

    var audioDecoderConfigurationOption = {
      AACDecOptions :{
        Bitrate : [8000],
        SampleRateRange : [48000]
      },
      G711DecOptions :{
        Bitrate : [8000],
        SampleRateRange : [48000]
      }
    }

    var h264profile = {
      "tt:Name": "H264Profile",
      attributes: {
        token: "h264_token"
      },
      "tt:VideoSourceConfiguration": videoSourceConfiguration,
      "tt:VideoEncoderConfiguration": videoEncoderConfiguration,
      "tt:PTZConfiguration": this.ptz_service.ptzConfiguration,
      "tt:AudioSourceConfiguration": audioSourceConfiguration,
      "tt:AudioEncoderConfiguration": audioEncoderConfigurationOption,
      "tt:Extension": {
        "tt:AudioOutputConfiguration":audioOutputConfiguration,
        "tt:AudioDecoderConfiguration": audioDecoderConfiguration
      }
    };

    var mjpegprofile = {
      "tt:Name": "MJPEGProfile",
      attributes: {
        token: "mjpeg_token"
      },
      "tt:VideoSourceConfiguration": videoSourceConfiguration,
      "tt:VideoEncoderConfiguration": videoEncoderConfiguration,
      "tt:PTZConfiguration": this.ptz_service.ptzConfiguration,
      "tt:AudioSourceConfiguration": audioSourceConfiguration,
      "tt:AudioEncoderConfiguration": audioEncoderConfigurationOption,
      "tt:Extension": {
        "tt:AudioOutputConfiguration":audioOutputConfiguration,
        "tt:AudioDecoderConfiguration": audioDecoderConfiguration
      }
    };

    //Overriding local trt prefix because its invoked from DeviceService as well
    port.GetServiceCapabilities = (args /*, cb, headers*/) => {
      var GetServiceCapabilitiesResponse = {
        'trt:Capabilities': {
          attributes: {
            SnapshotUri: true,
            Rotation: false,
            VideoSourceMode: true,
            OSD: false
          },
          'trt:ProfileCapabilities': {
            attributes: {
              MaximumNumberOfProfiles: 2
            }
          },
          'trt:StreamingCapabilities': {
            attributes: {
              RTPMulticast: this.config.MulticastEnabled,
              RTP_TCP: true,
              RTP_RTSP_TCP: true,
              NonAggregateControl: false,
              NoRTSPStreaming: false
            }
          }
        }
      };
      return GetServiceCapabilitiesResponse;
    };

    //var GetStreamUri = { 
    //StreamSetup : { 
    //Stream : { xs:string}
    //},
    //ProfileToken : { xs:string}
    //
    //};
    port.GetStreamUri = (args /*, cb, headers*/) => {
      // Usually RTSP server is on same IP Address as the ONVIF Service
      // Setting RTSPAddress in the config file lets you to use another IP Address
      let rtspAddress = utils.getIpAddress();
      if (this.config.RTSPAddress.length > 0) rtspAddress = this.config.RTSPAddress;
      var GetStreamUriResponse 
      if(args.StreamSetup != null){
        GetStreamUriResponse = {
          MediaUri: {
            "tt:Uri": (args.StreamSetup.Stream == "RTP-Multicast" && this.config.MulticastEnabled ? 
              `rtsp://${rtspAddress}:${this.config.RTSPPort}/${this.config.RTSPMulticastName}` :
              `rtsp://${rtspAddress}:${this.config.RTSPPort}/${this.config.RTSPName}`),
            "tt:InvalidAfterConnect": false,
            "tt:InvalidAfterReboot": false,
            "tt:Timeout": "PT30S"
          }
        };
      } else {
        GetStreamUriResponse = {
          MediaUri: {
            "tt:Uri": `rtsp://${rtspAddress}:${this.config.RTSPPort}/${this.config.RTSPName}`,
            "tt:InvalidAfterConnect": false,
            "tt:InvalidAfterReboot": false,
            "tt:Timeout": "PT30S"
          }
        };
      }
      return GetStreamUriResponse;
    };

    port.GetProfile = (args) => {
      var GetProfileResponse = { Profile: h264profile };
      return GetProfileResponse;
    };

    port.GetProfiles = (args) => {
      var GetProfilesResponse = { Profiles: [h264profile,mjpegprofile] };
      return GetProfilesResponse;
    };

    port.CreateProfile = (args) => {
      var CreateProfileResponse = { Profile: h264profile };
      return CreateProfileResponse;
    };

    port.DeleteProfile = (args) => {
      var DeleteProfileResponse = {};
      return DeleteProfileResponse;
    };

    port.GetVideoSources = (args) => {
        var GetVideoSourcesResponse = { VideoSources: [videoSource] };
        return GetVideoSourcesResponse;
    }

    port.GetVideoSourceConfigurations = (args) => {
      var GetVideoSourceConfigurationsResponse = { Configurations: [videoSourceConfiguration] };
      return GetVideoSourceConfigurationsResponse;
    };

    port.GetVideoSourceConfiguration = (args) => {
        var GetVideoSourceConfigurationResponse = { Configurations: videoSourceConfiguration };
        return GetVideoSourceConfigurationResponse;
    };

    port.GetVideoEncoderConfigurations = (args) => {
      var GetVideoEncoderConfigurationsResponse = { Configurations: [videoEncoderConfiguration] };
      return GetVideoEncoderConfigurationsResponse;
    };

    port.GetVideoEncoderConfiguration = (args) => {
      var GetVideoEncoderConfigurationResponse = { Configuration: videoEncoderConfiguration };
      return GetVideoEncoderConfigurationResponse;
    };

    port.SetVideoEncoderConfiguration = (args) => {
      var settings = {
        bitrate: args.Configuration.RateControl.BitrateLimit,
        framerate: args.Configuration.RateControl.FrameRateLimit,
        gop: args.Configuration.H264.GovLength,
        profile: args.Configuration.H264.H264Profile,
        quality: args.Configuration.Quality instanceof Object ? 1 : args.Configuration.Quality,
        resolution: args.Configuration.Resolution
      };
      camera.setSettings(settings);

      var SetVideoEncoderConfigurationResponse = {};
      return SetVideoEncoderConfigurationResponse;
    };

    port.GetVideoEncoderConfigurationOptions = (args) => {
      var GetVideoEncoderConfigurationOptionsResponse = { Options: videoConfigurationOptions };
      return GetVideoEncoderConfigurationOptionsResponse;
    };

    port.GetGuaranteedNumberOfVideoEncoderInstances = (args) => {
      var GetGuaranteedNumberOfVideoEncoderInstancesResponse = {
        TotalNumber: 1,
        H264: 1
      }
      return GetGuaranteedNumberOfVideoEncoderInstancesResponse;
    };

    port.GetSnapshotUri = (args) => {
      var GetSnapshotUriResponse = {
        MediaUri : {
          "tt:Uri" : "http://" + utils.getIpAddress() + ":" + this.config.ServicePort + "/web/snapshot.jpg",
          "tt:InvalidAfterConnect" : false,
          "tt:InvalidAfterReboot" : false,
          "tt:Timeout" : "PT30S"
        }
      };
      return GetSnapshotUriResponse;
    };


    port.GetAudioSources = (args) => {
      var GetAudioSourcesResponse = { AudioSources: [audioSource] };
      return GetAudioSourcesResponse;
    }

    port.GetAudioSourceConfigurations = (args) => {
      var GetAudioSourceConfigurationsResponse = { Configurations: [audioSourceConfiguration] };
      return GetAudioSourceConfigurationsResponse;
    };

    port.GetAudioSourceConfiguration = (args) => {
      var GetAudioSourceConfigurationResponse = { Configurations: audioSourceConfiguration };
      return GetAudioSourceConfigurationResponse;
    };

    port.GetCompatibleVideoSourceConfigurations = (args) => {
      // Args contains a ProfileToken
      // We will return all Video Sources as being compatible

      let GetCompatibleVideoSourceConfigurationsResponse = { Configurations: [videoSourceConfiguration] };
      return GetCompatibleVideoSourceConfigurationsResponse;
    }

    port.GetVideoSourceConfigurationOptions = (Args) => {
      // Args will contain a ConfigurationToken or ProfileToken
      var GetVideoSourceConfigurationOptionsResponse = { 
        Options : {
          BoundsRange : { 
            XRange : { 
              Min : 0,
              Max : 0
            },
            YRange : { 
              Min : 0,
              Max : 0
            },
            WidthRange : { 
              Min : 1920,
              Max : 1920
            },
            HeightRange : { 
              Min : 1080,
              Max : 1080
            }
          },
          VideoSourceTokensAvailable : "video_src_token"
          //Extension : { 
            //Rotate : { 
              //Mode : { xs:string},
              //DegreeList : { 
                //Items : [{ xs:int}]
              //},
              //Extension : { }
            //},
            //Extension : { }
          //}
        }
      };
        return GetVideoSourceConfigurationOptionsResponse;
    }
    
    port.GetAudioEncoderConfigurationOption = (args) => {
      var GetAudioEncoderConfigurationOptionResponse = { Configurations: audioEncoderConfigurationOption };
      return GetAudioEncoderConfigurationOptionResponse;
    };

    port.GetAudioOutputConfigurations = (args) => {
      var GetAudioOutputConfigurationsResponse = { Configurations: audioOutputConfiguration };
      return GetAudioOutputConfigurationsResponse;
    }

    //port.AddAudioOutputConfiguration = (args) => {
    //  utils.log.debug('Adding Audio Output Config ' + JSON.stringify(args));
    //}

    port.GetAudioDecoderConfigurations = (args) => {
      var GetAudioDecoderConfigurationsResponse = { Configurations: audioDecoderConfiguration};
      return GetAudioDecoderConfigurationsResponse;
    }

    port.GetAudioDecoderConfigurationOptions = (args) => {
      var GetAudioDecoderConfigurationOptionsResponse = { Options: [audioDecoderConfigurationOption]};
      return GetAudioDecoderConfigurationOptionsResponse;
    }


    port.GetCompatibleVideoEncoderConfigurations = (args) => {
      var GetCompatibleVideoEncoderConfigurationsResponse = { 
        //Configurations : [{ 
          //attributes : {
            //token : {tt:ReferenceToken}
          //},
          //Name : { xs:string},
          //UseCount : { xs:int}
        //
          //attributes : {
            //GuaranteedFrameRate : {xs:boolean}
          //},
          //Encoding : { xs:string},
          //Resolution : { 
            //Width : { xs:int},
            //Height : { xs:int}
          //},
          //Quality : { xs:float},
          //RateControl : { 
            //FrameRateLimit : { xs:int},
            //EncodingInterval : { xs:int},
            //BitrateLimit : { xs:int}
          //},
          //MPEG4 : { 
            //GovLength : { xs:int},
            //Mpeg4Profile : { xs:string}
          //},
          //H264 : { 
            //GovLength : { xs:int},
            //H264Profile : { xs:string}
          //},
          //Multicast : { 
            //Address : { 
              //Type : { xs:string},
              //IPv4Address : { xs:token},
              //IPv6Address : { xs:token}
            //},
            //Port : { xs:int},
            //TTL : { xs:int},
            //AutoStart : { xs:boolean}
          //},
          //SessionTimeout : { xs:duration}
        //}]
      //
      };
      return GetCompatibleVideoEncoderConfigurationsResponse;
    }
    port.GetCompatibleMetadataConfigurations = (args) => {
      var GetCompatibleMetadataConfigurationsResponse = { 
        //Configurations : [{ 
          //attributes : {
            //token : {tt:ReferenceToken}
          //},
          //Name : { xs:string},
          //UseCount : { xs:int}
        //
          //attributes : {
            //CompressionType : {xs:string},
            //GeoLocation : {xs:boolean},
            //ShapePolygon : {xs:boolean}
          //},
          //PTZStatus : { 
            //Status : { xs:boolean},
            //Position : { xs:boolean}
          //},
          //Events : { 
            //Filter : { wsnt:FilterType},
            //SubscriptionPolicy : { }
          //},
          //Analytics : { xs:boolean},
          //Multicast : { 
            //Address : { 
              //Type : { xs:string},
              //IPv4Address : { xs:token},
              //IPv6Address : { xs:token}
            //},
            //Port : { xs:int},
            //TTL : { xs:int},
            //AutoStart : { xs:boolean}
          //},
          //SessionTimeout : { xs:duration},
          //AnalyticsEngineConfiguration : { 
            //AnalyticsModule : [{ 
              //attributes : {
                //Name : {xs:string},
                //Type : {xs:QName}
              //},
              //Parameters : { 
                //SimpleItem : [{ }],
                //ElementItem : [{ }],
                //Extension : { }
              //}
            //}],
            //Extension : { }
          //},
          //Extension : { }
        //}]
      //
      };
      return GetCompatibleMetadataConfigurationsResponse;
    }
    port.GetCompatibleAudioEncoderConfigurations = (args) => {
      var GetCompatibleAudioEncoderConfigurationsResponse = { 
        //Configurations : [{ 
          //attributes : {
            //token : {tt:ReferenceToken}
          //},
          //Name : { xs:string},
          //UseCount : { xs:int}
        //
          //Encoding : { xs:string},
          //Bitrate : { xs:int},
          //SampleRate : { xs:int},
          //Multicast : { 
            //Address : { 
              //Type : { xs:string},
              //IPv4Address : { xs:token},
              //IPv6Address : { xs:token}
            //},
            //Port : { xs:int},
            //TTL : { xs:int},
            //AutoStart : { xs:boolean}
          //},
          //SessionTimeout : { xs:duration}
        //}]
      //
      };
      return GetCompatibleAudioEncoderConfigurationsResponse;
    }
  }
}
export = MediaService;
