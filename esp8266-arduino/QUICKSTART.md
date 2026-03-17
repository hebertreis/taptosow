# OneTapGo ESP8266 - Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Step 1: Install Dependencies

```bash
# Install PlatformIO Core (if not already installed)
pip install platformio

# Or install via Homebrew (macOS)
brew install platformio
```

### Step 2: Configure the Project

```bash
# Navigate to the project
cd esp8266-arduino

# Copy secrets template
cp secrets.h.example secrets.h

# Edit secrets.h with your credentials
# - MQTT username/password
# - WiFi AP password
# - OTA password (optional)
```

### Step 3: Build and Upload

```bash
# Connect your ESP8266 via USB

# Build the project
pio run -e nodemcuv2

# Upload to device
pio run -e nodemcuv2 -t upload

# Open serial monitor to see output
pio device monitor
```

### Step 4: Configure WiFi

1. **Power on the device** (or it will auto-restart after upload)
2. **Look for WiFi network**: `OneTapGo_XXXXXX`
3. **Connect** with password: `onetapgo` (or your custom password)
4. **Configuration portal** will open automatically
5. **Select your WiFi network** and enter password
6. **Save** - Device will reboot

### Step 5: Verify Connection

In the serial monitor (115200 baud), you should see:

```
========================================
   ONETAPGO NFC WRITER v3.0.0
        BY CRE8 TECNOLOGIA
========================================
[WiFi] Device ID: onetapgo_device_ab12cd
[WiFi] Connected successfully
[WiFi] IP address: 192.168.1.100
[MQTT] Connecting... OK
[MQTT] Subscribed to: onetapgo/device_ab12cd/command
[NFC] RC522 initialized successfully
```

### Step 6: Test with Web Admin

1. **Open admin interface**: `https://your-domain.com/admin.html`
2. **Enter device topic**: `onetapgo/device_ab12cd`
3. **Click "Subscribe"**
4. **Select tenant and sector**
5. **Click "Write"**
6. **Place NFC tag near reader**
7. **Check result on LCD and web admin**

## 📱 Web Admin Features

### QR Code Scanner Mode

For associating existing QR codes with tags:

1. Select tenant and sector
2. Click "Start QR Scanner"
3. Grant camera permission
4. Scan QR code
5. Tag will be created in Firebase

### MQTT Device Control Mode

For writing NFC tags via ESP8266:

1. Enter device topic
2. Click "Subscribe"
3. Select tenant and sector
4. Click "Write"
5. Place NFC tag on reader
6. Wait for success message

## 🔧 Troubleshooting

### Device Not Showing in Serial Monitor

```bash
# List available serial ports
pio device list

# Specify port explicitly
pio device monitor --port /dev/ttyUSB0  # Linux
pio device monitor --port COM3          # Windows
pio device monitor --port /dev/cu.usbserial-XXX  # macOS
```

### Upload Fails

1. Hold FLASH button while pressing RESET
2. Release RESET, then release FLASH
3. Try upload again
4. Or use: `pio run -e nodemcuv2 -t upload --upload-port /dev/your_port`

### WiFi Configuration Not Working

1. Reset device (press RST button)
2. Reconnect to `OneTapGo_XXXXXX`
3. Try configuration again
4. Check serial monitor for errors

### MQTT Connection Fails

1. Verify internet connection
2. Check MQTT credentials in secrets.h
3. Test connectivity: `ping m191dfff.ala.us-east-1.emqxsl.com`
4. Check firewall (port 8883 must be open)

### NFC Tag Not Detected

1. Check wiring (see README.md)
2. Ensure tag is Mifare Classic 1K
3. Hold tag closer to reader (direct contact)
4. Check RC522 is powered (3.3V, not 5V)

### LCD Not Working

1. Check I2C connections
2. Verify display is 3.3V compatible
3. Try different I2C address (0x3C or 0x3D)
4. Run I2C scanner example

## 📊 Monitoring Device Health

### Via Serial Monitor

```bash
pio device monitor
```

Look for heartbeat messages every 30 seconds.

### Via MQTT

Subscribe to device topics:

```
# Device status
onetapgo/device_ab12cd/status

# Heartbeat
onetapgo/device_ab12cd/heartbeat

# Results
onetapgo/device_ab12cd/result
```

### Via Web Admin

The connection status indicator shows:
- 🟢 Connected
- 🟡 Connecting
- 🔴 Disconnected

## 🔄 OTA Update (Optional)

### Enable OTA in Code

```cpp
// In onetapgo.ino, uncomment OTA section
#include <ArduinoOTA.h>

void otaInit() {
    ArduinoOTA.setHostname(deviceId.c_str());
    ArduinoOTA.setPassword(SECRETS_OTA_PASSWORD);
    ArduinoOTA.begin();
}

void systemLoop() {
    // ... existing code
    ArduinoOTA.handle(); // Add this line
}
```

### Upload via OTA

```bash
# First upload via USB with OTA enabled
pio run -e nodemcuv2 -t upload

# Subsequent updates via OTA
pio run -e nodemcuv2 -t upload --upload-protocol espota --upload-port onetapgo.local
```

## 📈 Production Checklist

Before deploying to production:

- [ ] Update MQTT credentials in secrets.h
- [ ] Change WiFi AP password
- [ ] Set OTA password
- [ ] Test with production MQTT broker
- [ ] Enable TLS certificate verification
- [ ] Configure Firebase security rules
- [ ] Test NFC write with production tags
- [ ] Verify LCD displays correctly
- [ ] Test WiFi reconnection
- [ ] Monitor for 24 hours
- [ ] Document device location and ID

## 📞 Support

- Documentation: See README.md for full details
- Security: See SECURITY.md for production hardening
- Issues: Check serial monitor for error messages

## 🎯 Next Steps

1. **Customize the URL** generated for tags (edit `generateOneTapGoUrl()`)
2. **Integrate with Firestore** for tag registration
3. **Add custom business logic** for your use case
4. **Deploy multiple devices** for scale
5. **Set up monitoring** and alerts

---

**Happy Tag Writing! 🏷️**
