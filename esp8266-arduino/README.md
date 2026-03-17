# OneTapGo ESP8266 NFC Writer - Production Deployment Guide

## Overview

This system enables NFC tag programming via MQTT communication between a web interface and ESP8266-based hardware with an RC522 NFC reader and SSD1306 LCD display.

### Architecture

```
┌─────────────────┐      MQTT (TLS)      ┌──────────────────────┐
│   Web Browser   │ ◄──────────────────► │   ESP8266 Device     │
│   (admin.html)  │                      │   (HW-364A Board)    │
│                 │                      │                      │
│ - QR Scanner    │                      │ - RC522 NFC Reader   │
│ - MQTT Client   │                      │ - SSD1306 LCD        │
│ - Firebase DB   │                      │ - WiFi Client        │
└─────────────────┘                      └──────────────────────┘
         │                                       │
         │                                       │
         ▼                                       ▼
┌─────────────────┐                      ┌──────────────────────┐
│  Firebase       │                      │   NFC Tags           │
│  Firestore      │                      │   (Mifare Classic)   │
└─────────────────┘                      └──────────────────────┘
```

## Hardware Requirements

### Bill of Materials

| Component | Specification | Quantity | Notes |
|-----------|--------------|----------|-------|
| ESP8266 Board | NodeMCU LoLin V3 | 1 | HW-364A with LCD connector |
| NFC Reader | MFRC522 (RC522) | 1 | 13.56 MHz RFID/NFC |
| LCD Display | SSD1306 OLED | 1 | 128x64, I2C interface |
| Antenna | NFC Antenna | 1 | Integrated in RC522 module |
| Jumper Wires | Female-to-Female | 12+ | For connections |
| USB Cable | Micro USB | 1 | For programming and power |

### Wiring Diagram

#### RC522 to NodeMCU LoLin V3

| RC522 Pin | NodeMCU Pin | GPIO | Note |
|-----------|-------------|------|------|
| RST | D1 | GPIO 5 | Reset |
| SS | D2 | GPIO 4 | Slave Select |
| MOSI | D7 | GPIO 13 | Master Out Slave In |
| MISO | D6 | GPIO 12 | Master In Slave Out |
| SCK | D5 | GPIO 14 | Clock |
| 3.3V | 3.3V | 3.3V | **DO NOT USE 5V** |
| GND | GND | GND | Ground |

#### SSD1306 OLED to NodeMCU LoLin V3

| OLED Pin | NodeMCU Pin | GPIO | Note |
|----------|-------------|------|------|
| VCC | 3.3V | 3.3V | Power |
| GND | GND | GND | Ground |
| SDA | D4 | GPIO 2 | I2C Data |
| SCL | D5 | GPIO 14 | I2C Clock |

**Important:** The HW-364A board has a built-in LCD connector. Verify pin assignments match your specific board revision.

## Software Installation

### Prerequisites

1. **PlatformIO IDE** (VS Code extension) or Arduino IDE 2.x
2. **Python 3.8+** (for PlatformIO)
3. **Git** (for version control)

### PlatformIO Setup

1. Open the project in VS Code with PlatformIO extension
2. Navigate to `esp8266-arduino/` directory
3. PlatformIO will automatically install dependencies

### Build and Upload

```bash
# Navigate to project directory
cd esp8266-arduino

# Build the project
pio run -e nodemcuv2

# Upload to device
pio run -e nodemcuv2 -t upload

# Open serial monitor
pio device monitor
```

### First-Time Configuration

1. **Power on the device** - It will create a WiFi Access Point
2. **Connect to WiFi**: `OneTapGo_XXXXXX` (password: `onetapgo`)
3. **Configuration portal** will open automatically (or go to `192.168.4.1`)
4. **Select your WiFi network** and enter credentials
5. **Save** - Device will reboot and connect to your network

## MQTT Configuration

### Connection Details

| Parameter | Value |
|-----------|-------|
| Host | `m191dfff.ala.us-east-1.emqxsl.com` |
| Port (TLS) | `8883` |
| WebSocket Port | `8084` |
| Username | `onetapgo` |
| Password | `onetapgo` |
| Protocol | MQTT 3.1.1 over TLS |

### Topic Structure

```
onetapgo/{deviceId}/
├── status      - Device status updates (online/offline)
├── heartbeat   - Periodic heartbeat messages
├── command     - Commands from web admin (subscribe)
└── result      - Write results and tag detection
```

### Message Formats

#### Command Message (Web → Device)

```json
{
  "type": "write_tag",
  "tenantId": "tenant123",
  "sectorId": "sector456",
  "timestamp": 1234567890
}
```

#### Heartbeat Message (Device → Web)

```json
{
  "type": "heartbeat",
  "deviceId": "onetapgo_device_ab12cd",
  "state": 0,
  "wifi_rssi": -65,
  "free_heap": 45678,
  "uptime": 123456,
  "timestamp": 1234567890
}
```

#### Result Message (Device → Web)

```json
{
  "type": "write_success",
  "deviceId": "onetapgo_device_ab12cd",
  "success": true,
  "timestamp": 1234567890
}
```

### State Values

| State | Value | Description |
|-------|-------|-------------|
| IDLE | 0 | Ready, waiting for command |
| WAITING_TAG | 1 | Waiting for NFC tag |
| TAG_DETECTED | 2 | Tag detected |
| WRITING | 3 | Writing to tag |
| SUCCESS | 4 | Write successful |
| ERROR | 5 | Write error |
| CONFIG_MODE | 6 | WiFi configuration mode |

## Web Admin Interface

### Access

The admin interface is available at: `https://your-domain.com/admin.html`

### Features

1. **QR Code Scanner** - Scan QR codes for tag association
2. **MQTT Device Control** - Send commands to ESP8266 devices
3. **Tenant/Sector Management** - Organize tags by tenant and sector
4. **Real-time Status** - View device connection status
5. **Activity Log** - Track all scan and write operations

### iOS/Safari Compatibility

The admin interface is optimized for iOS Safari with:
- Touch-friendly UI elements
- Proper viewport handling
- Haptic feedback (where supported)
- Dark mode support
- Prevents accidental zoom and refresh

### Usage Flow

1. **Select Tenant** - Choose the tenant from dropdown
2. **Select Sector** - Choose or create a sector
3. **Subscribe to Device** - Enter device topic and click Subscribe
4. **Send Write Command** - Click "Write" button
5. **Place NFC Tag** - Device will detect and write to tag
6. **Verify Result** - Check log for success/error status

## Production Best Practices

### Security

1. **Change Default Credentials**
   - Update MQTT username/password in production
   - Change WiFi AP password in `onetapgo.ino`

2. **TLS/SSL**
   - MQTT uses TLS encryption (port 8883)
   - Certificate verification is disabled for simplicity (`setInsecure()`)
   - For higher security, implement proper certificate validation

3. **Firebase Security Rules**
   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /tenants/{tenantId} {
         allow read: if request.auth != null;
         allow write: if request.auth != null && 
                      request.auth.token.admin == true;
       }
       match /tags/{tagId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```

### Reliability

1. **Watchdog Timer**
   - `yield()` calls prevent watchdog resets
   - Automatic reconnection logic for WiFi and MQTT

2. **Error Handling**
   - Graceful degradation on network failures
   - Retry logic with exponential backoff
   - Status reporting via MQTT and LCD

3. **Memory Management**
   - Static JSON documents to prevent fragmentation
   - Regular heap monitoring via heartbeat
   - Optimized for ESP8266's limited RAM

### Monitoring

1. **Device Health**
   - Heartbeat every 30 seconds
   - WiFi RSSI monitoring
   - Free heap space reporting
   - Uptime tracking

2. **Logging**
   - Serial logging at 115200 baud
   - MQTT message logging
   - LCD status display

3. **Alerts**
   - Monitor heartbeat frequency
   - Alert on repeated write failures
   - Monitor WiFi signal strength

### OTA Updates

Enable Over-The-Air updates for remote deployments:

```ini
; In platformio.ini
upload_protocol = espota
upload_port = onetapgo.local
upload_flags =
    --auth=your_ota_password
```

In code:
```cpp
#include <ArduinoOTA.h>

void otaInit() {
    ArduinoOTA.setHostname(deviceId.c_str());
    ArduinoOTA.setPassword("your_ota_password");
    ArduinoOTA.begin();
}

void otaLoop() {
    ArduinoOTA.handle();
}
```

## Troubleshooting

### Device Won't Connect to WiFi

1. Check WiFi credentials in configuration portal
2. Verify 2.4GHz network (ESP8266 doesn't support 5GHz)
3. Check signal strength (RSSI should be > -80)
4. Restart device and try again

### MQTT Connection Fails

1. Verify network connectivity (ping MQTT broker)
2. Check MQTT credentials
3. Verify port 8883 is not blocked by firewall
4. Check device time (TLS requires correct time)

### NFC Write Failures

1. Ensure tag is Mifare Classic 1K or compatible
2. Check tag proximity (hold closer to reader)
3. Verify RC522 antenna gain is set to maximum
4. Try formatting tag first (some tags need initialization)

### LCD Not Displaying

1. Check I2C connections (SDA, SCL)
2. Verify I2C address (0x3C or 0x3D)
3. Check power supply (3.3V, not 5V)
4. Run I2C scanner to detect display

### Serial Monitor Shows Garbage

1. Verify baud rate (115200)
2. Check USB cable quality
3. Try different USB port
4. Reset device after opening monitor

## Performance Optimization

### Memory Optimization

- Use `StaticJsonDocument` instead of `DynamicJsonDocument`
- Minimize String allocations
- Use `F()` macro for string literals
- Enable LTO in build flags

### Power Optimization

- Reduce heartbeat interval for battery operation
- Implement deep sleep between operations
- Disable LCD backlight when idle

### Network Optimization

- Use QoS 1 for critical messages
- Implement message deduplication
- Cache frequently used data

## API Reference

### Web Admin Functions

| Function | Description |
|----------|-------------|
| `initMQTT()` | Initialize MQTT connection |
| `subscribeToDevice(topic)` | Subscribe to device topic |
| `sendWriteCommand()` | Send write command to device |
| `publishMessage(topic, payload)` | Publish MQTT message |

### ESP8266 Functions

| Function | Description |
|----------|-------------|
| `wifiInit()` | Initialize WiFi with WiFiManager |
| `mqttInit()` | Initialize MQTT client |
| `mqttConnect()` | Connect to MQTT broker |
| `publishStatus()` | Publish device status |
| `publishHeartbeat()` | Publish heartbeat message |
| `writeNfcTag(tenant, sector)` | Write NFC tag with URL |
| `displayShowState(state)` | Update LCD display |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0.0 | 2026-03 | Production release with MQTT, WiFi Manager, LCD |
| 2.2 | 2025-12 | Basic NFC writer (legacy) |
| 1.0 | 2025-06 | Initial prototype |

## Support

For technical support and issues:
- GitHub Issues: [repository-url]
- Documentation: [docs-url]
- Email: support@onetapgo.site

## License

Copyright © 2026 OneTapGo by CRE8 Tecnologia. All rights reserved.

---

**Note:** This documentation is for production deployment. For development and testing guidelines, see `DEVELOPMENT.md`.
