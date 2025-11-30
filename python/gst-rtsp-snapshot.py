#!/usr/bin/python
# --------------------------------------------------------------------------- # 
# Supporting arguments
# --------------------------------------------------------------------------- # 
import argparse
parser = argparse.ArgumentParser(description="gst-rtsp-launch-py V0.1")
parser.add_argument('-v', '--verbose', action='store_true', help='Make script chatty')
parser.add_argument('-u', '--rtspurl', action='store', default="rtsp://127.0.0.1:554/", help='Set RTSP URL')
parser.add_argument('-o','--output',action='store', default='capture.png')
parser.add_argument('-M', '--mjpeg', action='store_true', help='Start with MJPEG codec')
args = parser.parse_args()

import os
import sys

# --------------------------------------------------------------------------- # 
# configure the service logging
# --------------------------------------------------------------------------- # 
import logging
logging.basicConfig()
log = logging.getLogger()


if args.verbose:
	log.setLevel(logging.DEBUG)
else:
	log.setLevel(logging.INFO)

# --------------------------------------------------------------------------- # 
# Use gi to import GStreamer functionality
# --------------------------------------------------------------------------- # 
import gi
gi.require_version('Gst','1.0')
gi.require_version('GstVideo','1.0')
gi.require_version('GstRtspServer','1.0')
from gi.repository import GObject, Gst, Gio,GstRtspServer,GstVideo, GLib

Gst.init(None)

appsink = "! appsink sync=false max-buffers=2 drop=true name=sink emit-signals=true"

#TODO Handle output format by extension type
pngenc = "! pngenc snapshot=true "
jpgenc = "! pngenc snapshot=true "

#TODO Handle input format by argument
h264in = "! rtph264depay ! h264parse ! avdec_h264 ! videoconvert "
mjpgin = "! rtpjpegdepay ! jpegparse ! jpegdec ! videoconvert "

pipelineStr = "rtspsrc location=\"" + args.rtspurl + "\" "
pipelineStr = pipelineStr + h264in
pipelineStr = pipelineStr + pngenc
pipelineStr = pipelineStr + appsink
log.debug(pipelineStr)
log.info("Creating Pipeline...")
pipe = Gst.parse_launch(pipelineStr)

log.info("Extracting buffer from appsink...")
sink = pipe.get_by_name('sink')
log.debug("Set to playing")
pipe.set_state(Gst.State.PLAYING)
log.debug("pull sample")
sample = sink.emit('pull-sample')
log.debug("get buffer")   
imgbuff = sample.get_buffer()

log.debug("read results")
result, map = imgbuff.map(Gst.MapFlags.READ)

if result:
	data = map.data
	log.debug("setting state to NULL")
	pipe.set_state(Gst.State.NULL)
	log.info("Writting to file : " + args.output)
	with open(args.output, 'wb') as file:
		file.write(data)
	log.info("Success")
else:
	log.info("Failed")
	exit (1)