#Save current working directory to run configure in
WORK_DIR=$(pwd)

#Get project root directory based on autogen.sh file location
SCRT_DIR=$(cd $(dirname "${BASH_SOURCE[0]}") && pwd)
cd $SCRT_DIR

mkdir -p subprojects
cd subprojects

git -C OnvifRtspLauncher pull 2> /dev/null || git clone https://github.com/Quedale/OnvifRtspLauncher.git
cd OnvifRtspLauncher

rm -rf build
mkdir -p build
cd build

../autogen.sh $@
make -j$(nproc)