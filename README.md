# Fork
This fork is to start working on a Profile T feature implementation. Including but not limited to: two-way audio, mjpeg and h265.

WIP - At this point the camera side of work should be functional. I just need a proper Onvif Profile T client to test it.   
I started working on a Onvif Linux Client for the sole purpose of testing this. [The [OnvifDeviceManager](https://github.com/Quedale/OnvifDeviceManager) repo is a WIP]  

I tried my best to implement the backchannel feature using the python bindings, but there seems to be a bug where a GstBuffer pointer reference is not released and won't get pushed on the backpipe.  
For now I gave up dealing with the python binding and I'm using my own launch solution.  

Update : I noticed some patch notes related to the new "push-backchannel-sample" signal, which is suposed to resolve this issue. (see comments under function *new_sample* in updated [test-onvif.c](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-plugins-good/tests/examples/rtsp/test-onvif.c))  

At this point I already have a decently functionnal rtsp launcher which supports backchannel.  
The sources for "onvifserver" can be found under the [OnvifRtspServer](https://github.com/Quedale/OnvifRtspLauncher) repository.  

# Fork features
I added a new RtspServer type (#4) configurable in the rposConfig.json file.  
The new type supports raw v4l and picam CameraDevice. (e.g. "/dev/video0" or "picam")  

"STEP 5.d" was added to the procedures below in order to use it.

No longer using a fork of node-soap and instead using latest version (2024-06).
Considerable amount of changes were necessary since the new version of node-soap has a hard time finding the appropriate nested nsPrefix.
Fortunately, the new node-soap version supports manually overriding the nsPrefix. The conversion isn't complete yet. Just barely to keep it functional for now.
The silver lining for this hassle is that it now supports anyType extensibility. 

Updated to latest WSDL definition (2024-06).

Using the latest version of npm (2024-06).

# rpos

Node.js based ONVIF Camera/NVT software that turns a Raspberry Pi, Windows, Linux or Mac computer into an ONVIF Camera and RTSP Server. It implements the key parts of Profile S and Profile T (http://www.onvif.org). It has special support for the Raspberry Pi Camera and Pimoroni Pan-Tilt HAT.

RPOS won an award in the 2018 ONVIF Open Source Challenge competition.

## History and Contributors

The initial goal (by @BreeeZe) was to provide a ONVIF Media service which is compatible with Synology Surveillance Station to allow the Raspberry Pi to be used as a surveillance camera without the need for adding any custom camera files to your Synology NAS.

The next goal (by @RogerHardiman) was to implement more of the ONVIF standard so that RPOS could be used with a wide range of CCTV systems and with ONVIF Device Manager and ONVIF Device Tool. Additional ONVIF Soap commands were added including the PTZ Service with backend drivers that control the Raspberry Pi Pan-Tit HAT or emit various RS485 based PTZ protocols including Pelco D and Sony Visca.

Oliver Schwaneberg added GStreamer gst-rtsp-server support as third RTSP Server option.

Casper Meijn added Relative PTZ support

Johnny Wan added some USB Camera support for GStreamer RTSP server.

If I've forgotten to put you in the list, please post an Issue Report and I can add you in.

## Features:

- Implements the ONVIF Standard for a CCTV Camera and NVT (Network Video Transmitter)
- Streams H264 video over RTSP from the Official Raspberry Pi camera (the one that uses the ribbon cable) and some USB cameras
- Uses hardware H264 encoding using the GPU on the Pi
- Implements Camera control (resolution and framerate) through ONVIF
- Can set other camera options through a web interface.
- Discoverable (WS-Discovery) on Pi/Linux by CCTV Viewing Software
- Works with ONVIF Device Manager (Windows) and ONVIF Device Tool (Linux)
- Works with other CCTV Viewing Software that implements the ONVIF standard including Antrica Decoder, Avigilon Control Centre, Bosch BVMS, Milestone, ISpy (Opensource), BenSoft SecuritySpy (Mac), IndigoVision Control Centre and Genetec Security Centre (add camera as ONVIF-BASIC mode)
- Implements ONVIF Authentication
- Implements Absolute, Relative and Continuous PTZ and controls the Pimononi Raspberry Pi Pan-Tilt HAT
- Can also use the Waveshare Pan-Tilt HAT with a custom driver for the PWM chip used but be aware the servos in their kit do not fit so we recommend the Pimoroni model
- Also converts ONVIF PTZ commands into Pelco D and Visca telemetry on a serial port (UART) for other Pan/Tilt platforms (ie a PTZ Proxy or PTZ Protocol Converter)
- Can reference other RTSP servers, which in turn can pull in the video via RTSP, other ONVIF sources, Desktop Capture, MJPEG allowing RPOS to be a Video Stream Proxy
- Implements Imaging service Brightness and Focus commands (for Profile T)
- Implements Relay (digital output) function
- Supports Unicast (UDP/TDP) and Multicast using mpromonet's RTSP server
- Supports Unicast (UDP/TCP) RTSP using GStreamer
- Works as a PTZ Proxy
- Also runs on Mac, Windows and other Linux machines but you need to supply your own RTSP server. An example to use ffserver on the Mac is included.
- USB cameras supported via the GStreamer RTSP server with limited parameters available. Tested with JPEG USB HD camera

![Picture of RPOS running on a Pi with the PanTiltHAT and Pi Camera](RPOS_PanTiltHAT.jpg?raw=true "PanTiltHAT")
Picture of RPOS running on a Pi 3 with the PiMoroni PanTiltHAT and Official Pi Camera

## How to Install on a Raspberry Pi:

### STEP 1 - CONFIG RASPBERRY PI
Windows/Mac/Linux users can skip this step

#### STEP 1.a - ENABLE RASPBERRY PI CAMERA
(For Raspberry PI camera)
Pi users can run ‘raspi-config’ and enable the camera and reboot  

#### STEP 1.b - ADJUST GPU MEMORY
(For USB camera, and need to use hardware encoding acceleration)
Add ‘gpu_mem=128’ in /boot/bootconf.txt and reboot

### STEP 2 - INSTALL NODEJS AND NPM

[This step was tested in Raspberry Pi OS from June 2021. Older Pis may need some manual steps]   

</b></b>
<ins>On the original Raspberry Pi Zero (armv6) node 21 seems to be the last unofficial build supported.</ins>   
<ins>Unofficial supported build available [here](https://unofficial-builds.nodejs.org/download/release/v21.6.2/).</ins>   

</b></b></b>
On newer Pi you can install nodejs (ver10) and npm (5.8.0) with this command
```
sudo apt install nodejs npm
```
Next we install 'n', a node version manager and install Node v21 and NPM v6
```
sudo npm install -g n
sudo n install 21
```
Log out and log back in for the Path changes to take effect. You should now have Node v21 (check with node -v) and NPM v6 (check with npm -v)


### STEP 3 - GET RPOS SOURCE, INSTALL DEPENDENCIES

```
git clone https://github.com/Quedale/rpos.git
cd rpos
npm install
```

### STEP 4 - COMPILE TYPESCRIPT(.ts) TO JAVASCRIPT(.js) using GULP

#### 4.1.a

Use the `npx` command to run the 'gulp' script: (works for NPM 5.2 and higher)

```
npx gulp
```

### STEP 5 - PICK YOUR RTSP SERVER

Select & setup an RTSP option for your platform.

RTSP Server options for Pi / Linux:

1. RPOS comes with a pre-compiled ARM binary for a simple RTSP server. The source is in the ‘cpp’ folder. (option 1)
1. mpromonet RTSP Server (option 2)
1. GStreamer RTSP Server (option 3)
1. Custom Gstreamer Onvif RTSP Server implementation [OnvifRtspServer](https://github.com/Quedale/OnvifRtspLauncher) (Option 4)

RTSP Server options 2 & 3 offer more features, but require additional setup. See instructions below.
Currently USB camera is only supported by GStreamer RTSP Server

Windows users will need to run their own RTSP Server.
Mac users can use the ffserver script.

Note: The choice of RTSP Server is made in rposConfig.json

#### STEP 5.a - OPTION 1: USING PRE-COMPILED ARM BINARY (deprecated)

This option is not recommended now. Please use Option 2 or Option 3
RPOS comes with a pre-compiled ARM binary for a simple RTSP server. The source is in the ‘cpp’ folder. No action required to use, this is pre-selected in `rposConfig.json`

Note that this option can be unstable, recommend option 2 or 3.

#### STEP 5.b - OPTION 2: USING MPROMONET RTSP SERVER

Raspberry Pi and Linux users will probably prefer the mpromonet RTSP server, as it has more options and supports multicasting.

Install dependencies and run setup script:

```
sudo apt-get install liblivemedia-dev
sh setup_v4l2rtspserver.sh
```

#### STEP 5.c - OPTION 3: USING GSTREAMER RTSP SERVER

Install the precompiled packages using apt, or compile them yourself for latest version.  
Installing the packages using apt saves a lot of time, but provides a rather old gstreamer version.

##### 5.c.1a - INSTALL GSTREAMER USING APT:

We will install lots of GStreamer Libraries and then the Python and GIR libraries (GIR allow other languages to access the GStreamer C API)
If you only use USB cameras, some may not be needed but for simplicity I'll install them all here.

```
sudo apt install git gstreamer1.0-plugins-base \
 gstreamer1.0-plugins-bad  gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly \
 gstreamer1.0-tools libgstreamer1.0-dev libgstreamer1.0-0-dbg \
 libgstreamer1.0-0 libgstrtspserver-1.0.0 \
 libgstreamer-plugins-base1.0-dev gtk-doc-tools \
 gstreamer1.0-omx-rpi gstreamer1.0-omx
```

You can check it is verson 1.14 with ```gst-launch-1.0 --version```

Then install Python Binding, GIR Files (GObjectIntrospection Repository - makes APIs from C libraries)
```
sudo apt-get install python-gi gir1.2-gst-plugins-base-1.0 gir1.2-gst-rtsp-server-1.0
```

##### 5.c.1b - INSTALL GST-RPICAMSRC FROM SOURCE
Currently Raspberry Pi OS installs GStreamer 1.14 which does not include the 'rpicamsrc' module so we will build it from source.

(starting in /rpos root directory)

```
cd ..
git clone https://github.com/thaytan/gst-rpicamsrc.git
cd gst-rpicamsrc
./autogen.sh
make
sudo make install
cd ..
```

Check successful plugin installation by executing

```
gst-inspect-1.0 rpicamsrc
```
Note: You do not need to load V4L2 modules when using rpicamsrc (option 3).

##### 5.c.2 - INSTALL GST-RTSP-SERVER FROM SOURCE

No longer required. Raspberry Pi OS in June 2021 is shipping with GStreamer 1.14 and the Gst RTSP Server library is included


#### STEP 5.d - OPTION 4: USING OnvifRtspLauncher (Fork Feature)
Running *autogen.sh* will pull, configure, and build OnvifRtspServer and its dependencies.  
OnvifRtspServer currently supports build under x86_64 and RPi4.  


##### Build Dependencies
Note that I don't like depending on sudo. I will eventually get around to identifying and building missing dependencies.

Install the latest build tools from pip and apt
```
sudo apt install python3-pip
python3 -m pip install pip --upgrade
python3 -m pip install meson
python3 -m pip install ninja
sudo apt install libtool
sudo apt install flex
sudo apt install bison
sudo apt install libasound2-dev
sudo apt install libpulse-dev
sudo apt install libgudev-1.0-dev
```
I'm not sure if this is true for all distros, but this is required to get the new binary in the system's PATH
```
export PATH=$PATH:$HOME/.local/bin
```

Install gettext
```
sudo apt-get install gettext
```

x86_64
```
./autogen.sh
```
RPi
```
./autogen.sh --enable-rpi
```

### STEP 6 - EDIT CONFIG
Go back to the 'rpos' folder

Rename or copy `rposConfig.sample-*.json` to `rposConfig.json`. (Choosing the appropriate sample to start with)

- Add a Username and Password for ONVIF access
- Change the TCP Port for the Camera configuration and the ONVIF Services
- Change the RTSP Port
- Enable PTZ support by selecting Pan-Tilt HAT or RS485 backends (Visca and Pelco D)
- Enable multicast
- Switch to the mpromonet or GStreamer RTSP servers
- Hardcode an IP address in the ONVIF SOAP messages

### STEP 6 - CONFIG DETAILS
The Configuation is split into several sections
#### IP Address and Login Permissions
- Network Adapters - Used by RPOS to probe network interfaces to try and work out its own IP Address
- IPAddress - This can be used to override the auto detected IP address found by probing the Network Adapters list
- Service Port - This is the TCP Port that RPOS listens on for ONVIF Connections
- Username - The username used to connect to RPOS with
- Password - The Password used to connect to RPOS with
#### Camera Source
This section helps RPOS know where to get live video from
- Camera Type - Used to help RPOS automatically configure itself. Valid optins are "picam", "usbcam", "filesrc", "testsrc".  'picam' will select the Raspberry Pi camera on the ribbon cable, 'usbcam' will select a USB camera, 'filesrc' will open a JPEG or PNG video file and 'testsrc' displays a bouncing ball with clock overlay
- CameraDevice - Provides extra information to go with the Camera Type. For 'usbcam' use the Video4Linux address of the camera, eg /dev/video0.  For the 'filesrc' camera type, use the full path and filename of the jpeg or PNG file eg /home/pi/image.jpg
#### RTSP Server
This section helps RPOS know how to share the video via RTSP with viewers
...
...


### STEP 7 - RUN RPOS.JS

#### First run (Skip with USB camera)

If you're using RTSP option 1 or 2, before you run RPOS for the first time you'll need to load the Pi V4L2 Camera Driver:

```
sudo modprobe bcm2835-v4l2
```

Initial setup is now complete!

#### Launch RPOS

To start the application:

```
node rpos.js
```

### STEP 8 - EXTRA CONFIGURATION ON PAN-TILT HAT (Pimononi)

The camera on the Pan-Tilt hat is usually installed upside down.
Goto the Web Page that runs with rpos `http://<CameraIP>:8081` and tick the horizontal and vertial flip boxes and apply the changes.

## Camera Settings

You can set camera settings by browsing to : `http://CameraIP:Port/`
These settings are then saved in a file called v4l2ctl.json and are persisted on rpos restart.
The default port for RPOS is 8081.
(Note that a lot of camera settings are now ignored by USB camera)

## Known Issues

- 1920x1080 can cause hangs and crashes with the original RTSP server. The mpromonet one may work better.
- 1920x1080 can cause encoding issue with USB camera pipeline. 1280x720 is recommended now.
- Not all of the ONVIF standard is implemented.

## ToDo's (Help is Required)

- Add MJPEG (implemented in gst-rtsp-server but still needs to return the correct ONVIF XML for MJPEG)
- Support more parameters for USB cameras with GStreamer RTSP server [work underway by RogerHardiman. Help needed]
- Support USB cameras with the Pi's Hardware H264 encoder (OMX) and the mpromonet RTP server (see https://github.com/mpromonet/v4l2tools)
- Implement more ONVIF calls (Events, Analytics)
- Test with ONVIF's own test tools (need a sponsor for this as we need to be ONVIF members to access the Test Tool)
- Add GPIO digital input
- Add two way audio with ONVIF back channel. We understand GStreamer has some support for this now.
- and more...
