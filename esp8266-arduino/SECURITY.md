# OneTapGo Production Security Guide

## 🔐 Security Checklist for Production Deployment

### 1. MQTT Credentials

**Current Status:** ⚠️ Using default credentials

**Action Required:**
```cpp
// In onetapgo.ino, update these values:
#define MQTT_USERNAME "your_production_username"
#define MQTT_PASSWORD "your_strong_password_here"
```

**Best Practices:**
- Use strong, randomly generated passwords (minimum 32 characters)
- Rotate credentials every 90 days
- Store credentials in a secrets manager (AWS Secrets Manager, HashiCorp Vault)
- Never commit credentials to version control

### 2. TLS/SSL Configuration

**Current Status:** ⚠️ Certificate verification disabled

**Current Code:**
```cpp
wifiClient.setInsecure(); // Skip certificate verification
```

**Production Recommendation:**
```cpp
// Include CA certificate for proper verification
#include <pgmspace.h>

// EMQX Cloud CA Certificate (get from your broker)
const char* EMQX_CA_CERT = R"EOF(
-----BEGIN CERTIFICATE-----
MIID... (your CA certificate here)
-----END CERTIFICATE-----
)EOF";

void mqttInit() {
    wifiClient.setCACert(EMQX_CA_CERT);
    // ... rest of init
}
```

**How to Get CA Certificate:**
```bash
# Download from your MQTT broker
openssl s_client -showcerts -connect m191dfff.ala.us-east-1.emqxsl.com:8883 \
    </dev/null 2>/dev/null | openssl x509 -outform PEM > emqx-ca.crt
```

### 3. WiFi Access Point Security

**Current Status:** ⚠️ Using default AP password

**Update in onetapgo.ino:**
```cpp
// Change AP password for production
const char* apPassword = "YourStrongAPPassword123!";
```

**Additional WiFi Security:**
```cpp
// Set minimum password length
wifiManager.setMinimumPasswordLength(12);

// Enable WPA2 only
wifiManager.setAPChannel(6); // Fixed channel
wifiManager.setHiddenAP(true); // Hidden SSID (optional)
```

### 4. Firebase Security Rules

**Deploy these rules to Firestore:**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper function to check if user is admin
    function isAdmin() {
      return request.auth != null && 
             get(/databases/$(database)/documents/users/$(request.auth.uid)).data.admin == true;
    }
    
    // Tenants collection
    match /tenants/{tenantId} {
      allow read: if request.auth != null;
      allow create: if isAdmin();
      allow update, delete: if false; // Prevent modification
      
      match /sectors/{sectorId} {
        allow read: if request.auth != null;
        allow write: if isAdmin();
      }
    }
    
    // Tags collection
    match /tags/{tagId} {
      allow read: if true; // Public read for tag resolution
      allow create: if request.auth != null && 
                       request.resource.data.keys().hasAll(['tenant', 'sectorId', 'url']);
      allow update: if isAdmin();
      allow delete: if false; // Prevent deletion
    }
    
    // Users collection (for admin management)
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if isAdmin() && request.auth.uid != userId; // Admins can't modify themselves
    }
    
    // Audit logs
    match /audit_logs/{logId} {
      allow read: if isAdmin();
      allow write: if false; // Append-only via Cloud Functions
    }
  }
}
```

### 5. Device Authentication

**Implement Device-Specific Credentials:**

```cpp
// Generate unique credentials per device
#define DEVICE_SECRET "device_specific_secret_here"

// In MQTT connection
String hmacSignature = generateHMAC(deviceId, DEVICE_SECRET);
mqttClient.connect(deviceId.c_str(), hmacSignature.c_str(), MQTT_PASSWORD);
```

**Device Registration Flow:**
1. Generate unique device ID and secret during manufacturing
2. Store in ESP8266's flash memory (encrypted)
3. Register device in Firebase Firestore
4. Use for MQTT authentication

### 6. OTA Update Security

**Enable Secure OTA:**

```cpp
#include <ArduinoOTA.h>

void otaInit() {
    ArduinoOTA.setHostname(deviceId.c_str());
    
    // Set OTA password (minimum 8 characters)
    ArduinoOTA.setPassword("YourOTAPassword123!");
    
    // Optional: Hash-based password
    // ArduinoOTA.setPasswordHash("21232f297a57a5a743894a0e4a801fc3");
    
    ArduinoOTA.onStart([]() {
        String type;
        if (ArduinoOTA.getCommand() == U_FLASH) type = "sketch";
        else type = "filesystem";
        Serial.println("Start updating " + type);
        displayShowMessage("OTA Update", "In progress...", 0);
    });
    
    ArduinoOTA.onEnd([]() {
        Serial.println("\nEnd");
        displayShowMessage("OTA Complete", "Restarting...", 2000);
    });
    
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
    });
    
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("Error[%u]: ", error);
        if (error == OTA_AUTH_ERROR) Serial.println("Auth Failed");
        else if (error == OTA_BEGIN_ERROR) Serial.println("Begin Failed");
        else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
        else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
        else if (error == OTA_END_ERROR) Serial.println("End Failed");
        displayShowMessage("OTA Error", "Update failed!", 3000);
    });
    
    ArduinoOTA.begin();
}
```

### 7. Input Validation

**Validate All MQTT Messages:**

```cpp
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    // Validate payload length
    if (length > 512) {
        Serial.println(F("[MQTT] Payload too large"));
        return;
    }
    
    // Parse JSON with error handling
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, payload, length);
    
    if (error) {
        Serial.print(F("[MQTT] JSON parse error: "));
        Serial.println(error.c_str());
        return;
    }
    
    // Validate required fields
    if (!doc.containsKey("type")) {
        Serial.println(F("[MQTT] Missing 'type' field"));
        return;
    }
    
    // Validate tenantId format (alphanumeric only)
    const char* tenantId = doc["tenantId"];
    if (tenantId != nullptr) {
        for (int i = 0; i < strlen(tenantId); i++) {
            if (!isAlphanumeric(tenantId[i])) {
                Serial.println(F("[MQTT] Invalid tenantId format"));
                return;
            }
        }
    }
    
    // ... rest of processing
}
```

### 8. Rate Limiting

**Prevent MQTT Message Flooding:**

```cpp
// Add to global variables
unsigned long lastCommandTime = 0;
const unsigned long COMMAND_COOLDOWN = 1000; // 1 second minimum between commands

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    // Rate limiting
    if (millis() - lastCommandTime < COMMAND_COOLDOWN) {
        Serial.println(F("[MQTT] Rate limit exceeded"));
        return;
    }
    lastCommandTime = millis();
    
    // ... rest of callback
}
```

### 9. Logging and Audit

**Enable Security Event Logging:**

```cpp
void logSecurityEvent(const String& event, const String& details) {
    StaticJsonDocument<256> doc;
    doc["event"] = event;
    doc["details"] = details;
    doc["deviceId"] = deviceId;
    doc["timestamp"] = millis();
    doc["wifi_rssi"] = WiFi.RSSI();
    
    String payload;
    serializeJson(doc, payload);
    
    // Publish to security topic
    publishMessage(mqttTopicBase + "/security", payload);
    
    // Also log to serial
    Serial.print(F("[SECURITY] "));
    Serial.println(payload);
}

// Usage examples:
logSecurityEvent("mqtt_connect", "Device connected to MQTT");
logSecurityEvent("write_attempt", "NFC write attempted");
logSecurityEvent("write_success", "NFC write successful");
logSecurityEvent("auth_failure", "MQTT authentication failed");
logSecurityEvent("firmware_update", "OTA update started");
```

### 10. Physical Security

**Recommendations:**
- Enclose device in tamper-resistant case
- Disable serial debug output in production
- Implement watchdog timer for automatic recovery
- Use read protection on ESP8266 flash

**Disable Serial Debug in Production:**
```cpp
// In onetapgo.ino, add conditional compilation
#ifndef PRODUCTION
    #define DEBUG_SERIAL Serial
#else
    #define DEBUG_SERIAL NullSerial
#endif

// Usage
DEBUG_SERIAL.println(F("Debug message"));
```

## Secrets Management

### Create secrets.h File

**Never commit this file to version control!**

```cpp
// secrets.h (ADD TO .gitignore)
#ifndef SECRETS_H
#define SECRETS_H

// MQTT Configuration
#define MQTT_USERNAME "production_user"
#define MQTT_PASSWORD "very_long_random_password_here"

// WiFi AP Password
#define WIFI_AP_PASSWORD "strong_ap_password"

// OTA Update Password
#define OTA_PASSWORD "secure_ota_password"

// Device Secret (unique per device)
#define DEVICE_SECRET "unique_device_secret"

// Firebase Configuration (if using direct access)
#define FIREBASE_API_KEY "your_api_key"
#define FIREBASE_PROJECT_ID "your_project_id"

// TLS Certificate (optional, for verification)
#define MQTT_CA_CERT R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF"

#endif // SECRETS_H
```

### Update .gitignore

```gitignore
# Secrets
**/secrets.h
**/.env
**/config.local.h
**/credentials.json

# Build artifacts
**/.pio/
**/.vscode/
```

### Include in Code

```cpp
// In onetapgo.ino
#ifdef PRODUCTION
    #include "secrets.h"
    
    // Use secrets
    #define MQTT_USERNAME SECRETS_MQTT_USERNAME
    #define MQTT_PASSWORD SECRETS_MQTT_PASSWORD
#endif
```

## Security Testing Checklist

Before production deployment:

- [ ] Change all default passwords
- [ ] Enable TLS certificate verification
- [ ] Configure Firebase security rules
- [ ] Test MQTT authentication
- [ ] Verify OTA update security
- [ ] Enable security event logging
- [ ] Test rate limiting
- [ ] Validate input sanitization
- [ ] Review serial output (no sensitive data)
- [ ] Test WiFi reconnection security
- [ ] Verify device authentication
- [ ] Conduct penetration testing

## Incident Response

### If Device is Compromised:

1. **Immediately rotate MQTT credentials**
2. **Revoke device from Firebase**
3. **Update device firmware remotely (OTA)**
4. **Review audit logs for unauthorized access**
5. **Investigate attack vector**

### Contact Information

- Security Team: security@onetapgo.site
- Emergency: +XX-XXX-XXX-XXXX

## Compliance

This implementation follows:
- OWASP IoT Security Guidelines
- MQTT Security Best Practices
- ESP8266 Security Recommendations

---

**Last Updated:** 2026-03-17  
**Version:** 1.0.0
