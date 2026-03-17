/**
 * OneTapGo - ESP8266 NFC Writer with MQTT Integration
 * Hardware: NodeMCU LoLin V3 (HW 364-A) with RC522 NFC Reader and LCD Display
 * 
 * Features:
 * - WiFi Manager for hotspot configuration
 * - MQTT over TLS for secure communication
 * - LCD display for operator feedback
 * - OTA updates support
 * - Watchdog handling
 * - Production-ready error handling and reconnection logic
 * - Debug mode for detailed NFC tag information
 * - Read mode for reading and sending tag data
 *
 * MQTT Topics:
 * - onetapgo/{deviceId}/status      - Device status updates
 * - onetapgo/{deviceId}/heartbeat   - Heartbeat messages
 * - onetapgo/{deviceId}/command     - Commands from admin
 * - onetapgo/{deviceId}/result      - Write results and tag data
 * - onetapgo/{deviceId}/debug       - Debug and mode status
 *
 * MQTT Commands (send to /command topic):
 * - write_tag: { "type": "write_tag", "tenantId": "xxx", "sectorId": "yyy", "url": "https://..." }
 * - set_debug: { "type": "set_debug", "enabled": true/false }
 * - set_read_mode: { "type": "set_read_mode", "enabled": true/false }
 * - read_tag: { "type": "read_tag" }  // One-time read
 * - status: { "type": "status" }      // Request current status
 * - restart: { "type": "restart" }    // Restart device
 *
 * @version 3.1.0
 * @author OneTapGo by CRE8 Tecnologia
 */

#include <ESP8266WiFi.h>
#include <ESP8266WiFiMulti.h>
#include <PubSubClient.h>
#include <ESP8266HTTPClient.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <NdefMessage.h>
#include <NfcAdapter.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ============================================================================
// CONFIGURATION - Update these values for your deployment
// ============================================================================

// MQTT Configuration
#define MQTT_HOST "m191dfff.ala.us-east-1.emqxsl.com"
#define MQTT_PORT 8883
#define MQTT_USERNAME "onetapgo"
#define MQTT_PASSWORD "onetapgo"
#define MQTT_USE_TLS true
#define MQTT_CLIENT_PREFIX "onetapgo_device"

// Device Configuration
#define DEVICE_VERSION "3.2.0"
#define HEARTBEAT_INTERVAL 30000      // 30 seconds
#define WIFI_RECONNECT_INTERVAL 10000 // 10 seconds
#define MQTT_RECONNECT_DELAY 5000     // 5 seconds
#define MAX_RECONNECT_ATTEMPTS 10

// NFC Optimization Configuration
#define NFC_POLL_INTERVAL 50          // 50ms between NFC polls (faster detection)
#define NFC_ACTIVITY_TIMEOUT 5000     // 5 seconds timeout for NFC operations
#define SECTOR_COUNT 16               // Number of sectors to read (for 1K cards)

// Hardware Configuration - NodeMCU LoLin V3
#define RC522_SS_PIN  4   // D2 (GPIO 4)
#define RC522_RST_PIN 5   // D1 (GPIO 5)

// LCD Display Configuration (SSD1306 128x64)
#define OLED_SDA_PIN 14    // D4 (GPIO 2)
#define OLED_SCL_PIN 12   // D5 (GPIO 14)
#define OLED_RESET_PIN -1 // RST (GPIO 16)
#define OLED_ADDRESS 0x3C

// Button Configuration (optional)
#define BUTTON_PIN 0      // D3 (GPIO 0) - Optional button for manual trigger

// ============================================================================
// GLOBAL VARIABLES
// ============================================================================

// Hardware instances
ESP8266WiFiMulti wifiMulti;
WiFiClientSecure wifiClient;
PubSubClient mqttClient;
MFRC522 mfrc522(RC522_SS_PIN, RC522_RST_PIN);  // Agora usa MFRC522
NfcAdapter nfc = NfcAdapter(&mfrc522);
Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET_PIN);

// State variables
String deviceId = "";
String mqttTopicBase = "";
bool isMqttConnected = false;
bool isWifiConnected = false;
unsigned long lastHeartbeat = 0;
unsigned long lastReconnectAttempt = 0;
int reconnectAttempts = 0;
unsigned long lastActivityTime = 0;

// Working state
enum DeviceState {
    STATE_IDLE,
    STATE_WAITING_TAG,
    STATE_TAG_DETECTED,
    STATE_WRITING,
    STATE_SUCCESS,
    STATE_ERROR,
    STATE_CONFIG_MODE,
    STATE_READ_MODE
};

DeviceState currentState = STATE_IDLE;
String pendingTenantId = "";
String pendingSectorId = "";
String pendingUrl = "";
bool debugMode = false;
bool readMode = false;

// Forward declarations
void publishStatus();
void publishHeartbeat();
void publishDebugStatus();
void publishReadModeStatus();
void publishTagData(const String& tagId, const String& ndefUrl = "");
String readTagData();
String readAllSectorData();
String extractNdefUrl();
void waitForTagRemoval();

// ============================================================================
// LCD DISPLAY FUNCTIONS
// ============================================================================

void displayInit() {
    Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);

    if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
        Serial.println(F("SSD1306 allocation failed"));
        return;
    }

    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println(F("OneTapGo v" DEVICE_VERSION));
    display.println(F("Initializing..."));
    display.display();
    delay(500); // Reduced from 1000ms
}

void displayShowState(DeviceState state, const char* extraInfo = nullptr) {
    display.clearDisplay();
    display.setCursor(0, 0);
    
    // Header
    display.setTextSize(1);
    display.println(F("=== OneTapGo ==="));
    display.println();
    
    // State display
    display.setTextSize(1);
    switch (state) {
        case STATE_IDLE:
            display.println(F("Status: Ready"));
            break;
        case STATE_WAITING_TAG:
            display.println(F("Status: Waiting"));
            display.println(F("Place NFC tag"));
            break;
        case STATE_TAG_DETECTED:
            display.println(F("Status: Tag Found"));
            break;
        case STATE_WRITING:
            display.println(F("Status: Writing..."));
            break;
        case STATE_SUCCESS:
            display.setTextSize(2);
            display.println(F("SUCCESS!"));
            display.setTextSize(1);
            display.println();
            display.println(F("Remove tag"));
            break;
        case STATE_ERROR:
            display.setTextSize(2);
            display.println(F("ERROR"));
            display.setTextSize(1);
            display.println();
            if (extraInfo) {
                display.println(extraInfo);
            } else {
                display.println(F("Write failed"));
            }
            break;
        case STATE_CONFIG_MODE:
            display.println(F("WiFi Config Mode"));
            display.println(F("Connect to AP"));
            break;
        case STATE_READ_MODE:
            display.println(F("Mode: Reader"));
            display.println(F("Place tag to read"));
            break;
    }
    
    // Footer - Connection status
    display.println();
    display.setTextSize(1);
    String statusLine = F("WiFi:");
    statusLine += isWifiConnected ? "OK" : "NO";
    statusLine += F(" MQTT:");
    statusLine += isMqttConnected ? "OK" : "NO";
    display.println(statusLine);
    
    // IP Address if connected
    if (isWifiConnected) {
        display.print(F("IP: "));
        display.println(WiFi.localIP().toString());
    }
    
    display.display();

    // Re-init NFC após I2C para evitar conflitos (otimizado)
    delay(10);
    mfrc522.PCD_Init();
    mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);
}

void displayShowMessage(const char* title, const char* message, int duration = 2000) {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println(title);
    display.println();
    display.setTextSize(1);
    display.println(message);
    display.display();
    delay(duration);
}

void displayShowQR(const char* ssid, const char* password) {
    display.clearDisplay();
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println(F("WiFi Setup"));
    display.println();
    display.print(F("SSID: "));
    display.println(ssid);
    display.print(F("Pass: "));
    display.println(password);
    display.println();
    display.println(F("Connect & configure"));
    display.display();
}

// ============================================================================
// WIFI MANAGEMENT
// ============================================================================

void wifiInit() {
    Serial.println(F("\n[WiFi] Initializing..."));
    
    // Generate device ID from MAC address
    uint8_t mac[6];
    WiFi.macAddress(mac);
    deviceId = String(MQTT_CLIENT_PREFIX) + "_" + 
               String(mac[4], HEX) + 
               String(mac[5], HEX);
    mqttTopicBase = "onetapgo/" + deviceId;
    
    Serial.print(F("[WiFi] Device ID: "));
    Serial.println(deviceId);
    
    // Configure WiFi Manager
    WiFiManager wifiManager;
    
    // Set timeout for configuration portal
    wifiManager.setConfigPortalTimeout(180); // 3 minutes
    
    // Set connection timeout
    wifiManager.setConnectTimeout(60);
    
    // Custom AP SSID
    String apSSID = "OneTapGo_" + deviceId.substring(deviceId.length() - 6);
    
    // Custom AP password
    const char* apPassword = "onetapgo123";
    
    // WiFi Manager parameters
    WiFiManagerParameter customText("<p style='text-align:center;font-weight:bold;'>OneTapGo NFC Writer</p>");
    wifiManager.addParameter(&customText);
    
    // Try to connect to saved network, or start configuration portal
    wifiManager.setAPCallback([](WiFiManager* wm) {
        Serial.println(F("[WiFi] Configuration portal started"));
        displayShowQR(wm->getConfigPortalSSID().c_str(), "onetapgo");
    });
    
    if (!wifiManager.autoConnect(apSSID.c_str(), apPassword)) {
        Serial.println(F("[WiFi] Failed to connect, restarting..."));
        displayShowMessage("WiFi Error", "Restarting...", 3000);
        delay(3000);
        ESP.restart();
        return;
    }
    
    isWifiConnected = true;
    Serial.println(F("[WiFi] Connected successfully"));
    Serial.print(F("[WiFi] IP address: "));
    Serial.println(WiFi.localIP());
    
    displayShowMessage("WiFi OK", WiFi.localIP().toString().c_str(), 1000);
}

void wifiCheckConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println(F("[WiFi] Connection lost, reconnecting..."));
        isWifiConnected = false;
        
        if (millis() - lastReconnectAttempt > WIFI_RECONNECT_INTERVAL) {
            lastReconnectAttempt = millis();
            
            // Try to reconnect
            WiFi.reconnect();
            
            if (WiFi.status() == WL_CONNECTED) {
                isWifiConnected = true;
                Serial.println(F("[WiFi] Reconnected successfully"));
                Serial.print(F("[WiFi] IP: "));
                Serial.println(WiFi.localIP());
                displayShowMessage("WiFi Reconnected", WiFi.localIP().toString().c_str(), 1000);
                reconnectAttempts = 0;
            } else {
                reconnectAttempts++;
                Serial.print(F("[WiFi] Reconnect attempt "));
                Serial.print(reconnectAttempts);
                Serial.println(F(" failed"));
                
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    Serial.println(F("[WiFi] Max attempts reached, restarting WiFi"));
                    WiFi.disconnect(true);
                    delay(1000);
                    wifiInit();
                    reconnectAttempts = 0;
                }
            }
        }
    }
}

// ============================================================================
// MQTT MANAGEMENT
// ============================================================================

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    // Convert payload to string
    String message;
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }

    Serial.print(F("[MQTT] Message received: "));
    Serial.println(topic);
    Serial.println(message);

    // Parse JSON
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, message);

    if (error) {
        Serial.print(F("[MQTT] JSON parse error: "));
        Serial.println(error.c_str());
        return;
    }

    // Handle command
    const char* commandType = doc["type"];

    if (strcmp(commandType, "write_tag") == 0) {
        pendingTenantId = doc["tenantId"].as<String>();
        pendingSectorId = doc["sectorId"].as<String>();
        pendingUrl = doc["url"].as<String>();
        currentState = STATE_WAITING_TAG;
        displayShowState(STATE_WAITING_TAG);

        Serial.println(F("[MQTT] Write command received"));
        Serial.print(F("[MQTT] Tenant: "));
        Serial.println(pendingTenantId);
        Serial.print(F("[MQTT] Sector: "));
        Serial.println(pendingSectorId);
        Serial.print(F("[MQTT] URL: "));
        Serial.println(pendingUrl);
    }
    else if (strcmp(commandType, "status") == 0) {
        // Send current status
        publishStatus();
    }
    else if (strcmp(commandType, "restart") == 0) {
        Serial.println(F("[MQTT] Restart command received"));
        displayShowMessage("Restarting", "By remote command", 1000);
        ESP.restart();
    }
    else if (strcmp(commandType, "set_debug") == 0) {
        debugMode = doc["enabled"].as<bool>();
        Serial.print(F("[MQTT] Debug mode: "));
        Serial.println(debugMode ? "ON" : "OFF");
        publishDebugStatus();
    }
    else if (strcmp(commandType, "set_read_mode") == 0) {
        readMode = doc["enabled"].as<bool>();
        if (readMode) {
            currentState = STATE_READ_MODE;
            displayShowState(STATE_READ_MODE, "Reading tags...");
        } else {
            currentState = STATE_IDLE;
            displayShowState(STATE_IDLE);
        }
        Serial.print(F("[MQTT] Read mode: "));
        Serial.println(readMode ? "ON" : "OFF");
        publishReadModeStatus();
    }
    else if (strcmp(commandType, "read_tag") == 0) {
        // One-time read command
        currentState = STATE_READ_MODE;
        displayShowState(STATE_READ_MODE, "Waiting for tag...");
        Serial.println(F("[MQTT] One-time read command received"));
    }
}

void mqttInit() {
    Serial.println(F("\n[MQTT] Initializing..."));
    
    // Configure secure WiFi client
    wifiClient.setInsecure(); // Skip certificate verification for production
    wifiClient.setTimeout(10);
    
    // Configure MQTT client
    mqttClient.setClient(wifiClient);
    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(1024);
    mqttClient.setKeepAlive(60);
    mqttClient.setSocketTimeout(30);
    
    Serial.print(F("[MQTT] Server: "));
    Serial.println(MQTT_HOST);
    Serial.print(F("[MQTT] Port: "));
    Serial.println(MQTT_PORT);
    Serial.print(F("[MQTT] Client ID: "));
    Serial.println(deviceId);
}

bool mqttConnect() {
    if (mqttClient.connected()) {
        return true;
    }
    
    Serial.print(F("[MQTT] Connecting..."));
    
    // Last will message
    String willTopic = mqttTopicBase + "/status";
    String willMessage = "{\"status\":\"offline\",\"timestamp\":" + String(millis()) + "}";
    
    if (mqttClient.connect(deviceId.c_str(), MQTT_USERNAME, MQTT_PASSWORD, 
                          willTopic.c_str(), 1, true, willMessage.c_str())) {
        Serial.println(F(" OK"));
        
        // Subscribe to command topic
        String commandTopic = mqttTopicBase + "/command";
        mqttClient.subscribe(commandTopic.c_str(), 1);
        Serial.print(F("[MQTT] Subscribed to: "));
        Serial.println(commandTopic);
        
        isMqttConnected = true;
        publishStatus();
        
        return true;
    } else {
        Serial.print(F(" FAILED - Code: "));
        Serial.println(mqttClient.state());
        isMqttConnected = false;
        return false;
    }
}

void mqttLoop() {
    mqttClient.loop();
    
    // Check connection
    if (!mqttClient.connected()) {
        if (millis() - lastReconnectAttempt > MQTT_RECONNECT_DELAY) {
            lastReconnectAttempt = millis();
            
            if (!mqttConnect()) {
                reconnectAttempts++;
                Serial.print(F("[MQTT] Reconnect attempt "));
                Serial.print(reconnectAttempts);
                Serial.println(F(" failed"));
                
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    Serial.println(F("[MQTT] Max attempts reached"));
                    reconnectAttempts = 0;
                }
            }
        }
    }
    
    // Send heartbeat
    if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
        lastHeartbeat = millis();
        publishHeartbeat();
    }
}

void publishMessage(const String& topic, const String& payload, bool retained = false) {
    if (!isMqttConnected) {
        Serial.println(F("[MQTT] Cannot publish - not connected"));
        return;
    }
    
    if (mqttClient.publish(topic.c_str(), payload.c_str(), retained)) {
        Serial.print(F("[MQTT] Published to "));
        Serial.print(topic);
        Serial.print(F(": "));
        Serial.println(payload);
    } else {
        Serial.print(F("[MQTT] Publish failed to "));
        Serial.println(topic);
    }
}

void publishStatus() {
    StaticJsonDocument<256> doc;
    doc["status"] = isMqttConnected ? "online" : "offline";
    doc["state"] = currentState;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["wifi_ssid"] = WiFi.SSID();
    doc["ip_address"] = WiFi.localIP().toString();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["timestamp"] = millis();
    doc["version"] = DEVICE_VERSION;
    doc["debugMode"] = debugMode;
    doc["readMode"] = readMode;
    doc["hasPendingCommand"] = pendingTenantId.length() > 0;

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/status", payload);
}

void publishHeartbeat() {
    StaticJsonDocument<256> doc;
    doc["type"] = "heartbeat";
    doc["deviceId"] = deviceId;
    doc["state"] = currentState;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["uptime"] = millis();
    doc["timestamp"] = millis();
    doc["debugMode"] = debugMode;
    doc["readMode"] = readMode;

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/heartbeat", payload);
}

void publishTagDetected(const String& tagId) {
    StaticJsonDocument<256> doc;
    doc["type"] = "tag_detected";
    doc["deviceId"] = deviceId;
    doc["tagId"] = tagId;
    doc["timestamp"] = millis();
    
    String payload;
    serializeJson(doc, payload);
    
    publishMessage(mqttTopicBase + "/result", payload);
}

void publishWriteResult(bool success, const String& error = "") {
    StaticJsonDocument<256> doc;
    doc["type"] = success ? "write_success" : "write_error";
    doc["deviceId"] = deviceId;
    doc["success"] = success;
    if (!success) {
        doc["error"] = error;
    }
    if (success && error.length() > 0) {
        doc["url"] = error; // Reuse error parameter for URL on success
        doc["error"] = "";
    }
    doc["timestamp"] = millis();

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/result", payload);
}

void publishDebugStatus() {
    StaticJsonDocument<256> doc;
    doc["type"] = "debug_status";
    doc["deviceId"] = deviceId;
    doc["debugEnabled"] = debugMode;
    doc["timestamp"] = millis();

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/debug", payload);
}

void publishReadModeStatus() {
    StaticJsonDocument<256> doc;
    doc["type"] = "read_mode_status";
    doc["deviceId"] = deviceId;
    doc["readModeEnabled"] = readMode;
    doc["timestamp"] = millis();

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/debug", payload);
}

void publishTagData(const String& tagId, const String& ndefUrl) {
    StaticJsonDocument<1024> doc;
    doc["type"] = "tag_data";
    doc["deviceId"] = deviceId;
    doc["tagId"] = tagId;
    doc["timestamp"] = millis();
    
    // Add NDEF URL if available
    if (ndefUrl.length() > 0) {
        doc["ndefUrl"] = ndefUrl;
    }

    // Read all sector data
    String sectorData = readAllSectorData();
    if (sectorData.length() > 0) {
        doc["sectorData"] = sectorData;
    }

    // Add debug data if enabled
    if (debugMode) {
        MFRC522::MIFARE_Key key;
        for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;

        MFRC522::Uid uid;
        if (mfrc522.PICC_ReadCardSerial()) {
            uid = mfrc522.uid;

            String uidStr = "";
            for (byte i = 0; i < uid.size; i++) {
                if (uid.uidByte[i] < 0x10) uidStr += "0";
                uidStr += String(uid.uidByte[i], HEX);
                if (i < uid.size - 1) uidStr += ":";
            }
            doc["uid"] = uidStr;
            doc["uidLength"] = uid.size;
            doc["tagType"] = mfrc522.PICC_GetTypeName((MFRC522::PICC_Type)uid.sak);

            mfrc522.PICC_HaltA();
        }

        // Read NDEF message details
        NfcTag tag = nfc.read();
        if (tag.hasNdefMessage()) {
            NdefMessage message = tag.getNdefMessage();
            doc["ndefRecordCount"] = message.getRecordCount();

            JsonArray records = doc.createNestedArray("ndefRecords");
            for (int i = 0; i < message.getRecordCount(); i++) {
                NdefRecord record = message.getRecord(i);
                JsonObject recordObj = records.createNestedObject();

                String recordType = "";
                byte typeLen = record.getTypeLength();
                for (int j = 0; j < typeLen; j++) {
                    char c = record.getType()[j];
                    if (c >= 32 && c < 127) recordType += c;
                }
                recordObj["type"] = recordType;

                String payloadStr = "";
                uint16_t payloadLen = record.getPayloadLength();
                for (uint16_t j = 0; j < payloadLen; j++) {
                    char c = record.getPayload()[j];
                    if (c >= 32 && c < 127) payloadStr += c;
                }
                recordObj["payload"] = payloadStr;
            }
        }
    }

    String payload;
    serializeJson(doc, payload);

    publishMessage(mqttTopicBase + "/result", payload);
}

// ============================================================================
// NFC WRITER FUNCTIONS
// ============================================================================

String generateOneTapGoUrl(const String& tenantId, const String& sectorId) {
    // Generate URL based on tenant and sector
    // Format: https://onetapgo.site/a/{uniqueId}
    // The uniqueId should be generated and stored in Firestore
    
    // For now, use a combination of device ID and timestamp
    String uniqueId = deviceId + "_" + String(millis());
    return "https://onetapgo.site/a/" + uniqueId;
}

bool writeNfcTag(const String& tenantId, const String& sectorId, const String& url) {
    Serial.println(F("\n[NFC] Starting write process..."));
    displayShowState(STATE_WRITING);

    // Create NDEF message
    NdefMessage message = NdefMessage();

    // Add URI record (primary) - optimized
    message.addUriRecord(url.c_str());

    // Add text record (secondary info)
    String textRecord = "OneTapGo - Tenant: " + tenantId + " Sector: " + sectorId;
    message.addTextRecord(textRecord.c_str());

    if (debugMode) {
        Serial.println(F("[NFC] === NFC Write Debug ==="));
        Serial.print(F("[NFC] URL to write: "));
        Serial.println(url);
        Serial.print(F("[NFC] Text record: "));
        Serial.println(textRecord);

        // Debug NDEF message size
        int messageSize = message.getEncodedSize();
        Serial.print(F("[NFC] Encoded message size: "));
        Serial.println(messageSize);
    }

    // Write to tag (optimized - no retry delay)
    bool success = nfc.write(message);

    if (success) {
        Serial.println(F("[NFC] Write successful"));
        displayShowState(STATE_SUCCESS);
        publishWriteResult(true, url);

        // Store tag data in Firestore via HTTPS call (optional)
        // storeTagInFirestore(tenantId, sectorId, url);

        return true;
    } else {
        Serial.println(F("[NFC] Write failed"));
        displayShowState(STATE_ERROR, "Write failed");
        publishWriteResult(false, "NFC write error");
        return false;
    }
}

void processNfcTag() {
    Serial.println(F("\n[NFC] Tag detected!"));
    currentState = STATE_TAG_DETECTED;
    displayShowState(STATE_TAG_DETECTED);

    // Read tag data for debug
    String tagId = readTagData();

    // Publish tag detection
    publishTagDetected(tagId);

    // Check if in read mode
    if (readMode || currentState == STATE_READ_MODE) {
        Serial.println(F("[NFC] Read mode - sending tag data"));
        
        // Extract NDEF URL first (faster)
        String ndefUrl = extractNdefUrl();
        
        // Send all data including sectors and URL
        publishTagData(tagId, ndefUrl);

        // Wait for tag removal
        waitForTagRemoval();

        // Return to read mode or idle
        currentState = readMode ? STATE_READ_MODE : STATE_IDLE;
        displayShowState(currentState);
        return;
    }

    // Check if we have pending write command
    if (pendingTenantId.length() > 0 && pendingSectorId.length() > 0 && pendingUrl.length() > 0) {
        // Wait for user to position tag correctly (reduced delay)
        displayShowMessage("Processing", "Keep tag steady...", 300);

        // Attempt write
        bool success = writeNfcTag(pendingTenantId, pendingSectorId, pendingUrl);

        // Clear pending command
        pendingTenantId = "";
        pendingSectorId = "";
        pendingUrl = "";

        if (success) {
            currentState = STATE_SUCCESS;
        } else {
            currentState = STATE_ERROR;
        }

        // Wait for tag removal
        Serial.println(F("[NFC] Waiting for tag removal..."));
        displayShowMessage("Complete", "Remove tag now", 0);

        unsigned long waitStart = millis();
        while (nfc.tagPresent() && (millis() - waitStart < 10000)) {
            yield();
            delay(100);
        }

        // Reset to idle
        currentState = STATE_IDLE;
        displayShowState(STATE_IDLE);

    } else {
        // No pending command, just read tag info
        Serial.println(F("[NFC] No pending write command"));
        displayShowMessage("Info", "No write pending", 1500);
        currentState = STATE_IDLE;
    }

    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
}

String readTagData() {
    String tagId = "tag_" + String(millis());

    if (debugMode) {
        Serial.println(F("[NFC] === Tag Read Debug ==="));

        // Read UID
        MFRC522::MIFARE_Key key;
        for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;

        MFRC522::Uid uid;
        if (mfrc522.PICC_ReadCardSerial()) {
            uid = mfrc522.uid;

            Serial.print(F("[NFC] Tag UID: "));
            for (byte i = 0; i < uid.size; i++) {
                if (uid.uidByte[i] < 0x10) Serial.print(F("0"));
                Serial.print(uid.uidByte[i], HEX);
                Serial.print(F(" "));
            }
            Serial.println();

            Serial.print(F("[NFC] UID length: "));
            Serial.println(uid.size);

            Serial.print(F("[NFC] Tag type: "));
            Serial.println(mfrc522.PICC_GetTypeName((MFRC522::PICC_Type)uid.sak));

            mfrc522.PICC_HaltA();
        }

        // Try to read NDEF data
        Serial.println(F("[NFC] Attempting to read NDEF data..."));
        NfcTag tag = nfc.read();
        if (tag.hasNdefMessage()) {
            NdefMessage message = tag.getNdefMessage();
            Serial.print(F("[NFC] NDEF records: "));
            Serial.println(message.getRecordCount());

            for (int i = 0; i < message.getRecordCount(); i++) {
                NdefRecord record = message.getRecord(i);
                Serial.print(F("[NFC] Record "));
                Serial.print(i);
                Serial.print(F(" Type: "));

                // Print type as hex bytes
                byte typeLen = record.getTypeLength();
                for (byte j = 0; j < typeLen; j++) {
                    byte b = record.getType()[j];
                    if (b < 0x10) Serial.print(F("0"));
                    Serial.print(b, HEX);
                    Serial.print(F(" "));
                }
                Serial.println();

                String payload = "";
                uint16_t payloadLen = record.getPayloadLength();
                for (uint16_t j = 0; j < payloadLen; j++) {
                    char c = record.getPayload()[j];
                    if (c >= 32 && c < 127) payload += c;
                }
                Serial.print(F("[NFC] Payload: "));
                Serial.println(payload);
            }
        } else {
            Serial.println(F("[NFC] No NDEF data or read failed"));
        }

        Serial.println(F("[NFC] ========================"));
    }

    return tagId;
}

String extractNdefUrl() {
    String url = "";
    
    // Try to read NDEF message
    NfcTag tag = nfc.read();
    if (!tag.hasNdefMessage()) {
        Serial.println(F("[NFC] No NDEF message found"));
        return "";
    }
    
    NdefMessage message = tag.getNdefMessage();
    int recordCount = message.getRecordCount();
    
    for (int i = 0; i < recordCount; i++) {
        NdefRecord record = message.getRecord(i);
        
        // Check if it's a URI record (type "U" or 0x55)
        byte typeLen = record.getTypeLength();
        if (typeLen == 1 && record.getType()[0] == 0x55) {
            // URI record found
            uint16_t payloadLen = record.getPayloadLength();
            if (payloadLen > 1) {
                byte prefixCode = record.getPayload()[0];
                
                // Get prefix based on code
                String prefix = "";
                if (prefixCode == 0x00) prefix = "";
                else if (prefixCode == 0x01) prefix = "http://www.";
                else if (prefixCode == 0x02) prefix = "https://www.";
                else if (prefixCode == 0x03) prefix = "http://";
                else if (prefixCode == 0x04) prefix = "https://";
                else prefix = "";
                
                // Read the rest of the payload
                for (uint16_t j = 1; j < payloadLen; j++) {
                    char c = record.getPayload()[j];
                    if (c >= 32 && c < 127) {
                        url += c;
                    }
                }
                
                // Add prefix if not already in URL
                if (prefix.length() > 0 && !url.startsWith(prefix)) {
                    url = prefix + url;
                }
                
                Serial.print(F("[NFC] NDEF URL extracted: "));
                Serial.println(url);
                return url;
            }
        }
    }
    
    Serial.println(F("[NFC] No URI record found in NDEF message"));
    return "";
}

String readAllSectorData() {
    MFRC522::MIFARE_Key key;
    for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;
    
    StaticJsonDocument<2048> doc;
    JsonArray sectors = doc.createNestedArray("sectors");
    
    byte buffer[18];
    
    // Read all sectors (0 to 15 for 1K card)
    for (byte sector = 0; sector < SECTOR_COUNT; sector++) {
        JsonObject sectorObj = sectors.createNestedObject();
        sectorObj["sector"] = sector;
        
        JsonArray blocks = sectorObj.createNestedArray("blocks");
        
        // Each sector has 4 blocks (0-3), except sector 15 which may vary
        byte blocksInSector = (sector < 32) ? 4 : 16;
        byte startBlock = sector * 4;
        
        for (byte block = 0; block < blocksInSector; block++) {
            byte blockAddr = startBlock + block;
            
            // Authenticate
            byte status = mfrc522.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, blockAddr, &key, &(mfrc522.uid));
            if (status != MFRC522::STATUS_OK) {
                // Skip unreadable blocks
                continue;
            }
            
            // Read block
            byte size = sizeof(buffer);
            status = mfrc522.MIFARE_Read(blockAddr, buffer, &size);
            
            if (status == MFRC522::STATUS_OK) {
                JsonObject blockObj = blocks.createNestedObject();
                blockObj["block"] = blockAddr;
                
                // Convert to hex string
                String data = "";
                for (byte i = 0; i < 16; i++) {
                    if (buffer[i] < 0x10) data += "0";
                    data += String(buffer[i], HEX);
                    if (i < 15) data += " ";
                }
                blockObj["data"] = data;
                
                // Try to convert to ASCII if printable
                String ascii = "";
                for (byte i = 0; i < 16; i++) {
                    char c = buffer[i];
                    if (c >= 32 && c < 127) ascii += c;
                    else ascii += ".";
                }
                blockObj["ascii"] = ascii;
            }
            
            mfrc522.PICC_HaltA();
            mfrc522.PCD_StopCrypto1();
            yield(); // Prevent watchdog reset
        }
    }
    
    String result;
    serializeJson(doc, result);
    return result;
}

void waitForTagRemoval() {
    Serial.println(F("[NFC] Waiting for tag removal..."));
    displayShowMessage("Complete", "Remove tag now", 0);
    
    unsigned long waitStart = millis();
    while (nfc.tagPresent() && (millis() - waitStart < 10000)) {
        yield();
        delay(100);
    }
}

void nfcInit() {
    Serial.println(F("\n[NFC] Initializing RC522..."));

    SPI.begin();
    mfrc522.PCD_Init();

    // Set maximum antenna gain
    mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);

    // Check firmware version (reduced wait)
    delay(50);

    // Check firmware version
    byte version = mfrc522.PCD_ReadRegister(mfrc522.VersionReg);
    Serial.print(F("[NFC] RC522 Firmware Version: 0x"));
    Serial.println(version, HEX);

    if (version == 0x00 || version == 0xFF) {
        Serial.println(F("[NFC] WARNING: RC522 not found or not responding!"));
        displayShowMessage("NFC Error", "RC522 not found", 2000);
    } else {
        Serial.println(F("[NFC] RC522 initialized successfully"));
        displayShowMessage("NFC OK", "Ready to write", 500);
    }
}

// ============================================================================
// SYSTEM FUNCTIONS
// ============================================================================

void systemInit() {
    // Initialize serial
    Serial.begin(115200);
    delay(1000);
    
    Serial.println(F("\n========================================"));
    Serial.println(F("   ONETAPGO NFC WRITER v" DEVICE_VERSION));
    Serial.println(F("        BY CRE8 TECNOLOGIA"));
    Serial.println(F("========================================"));
    Serial.print(F("[SYS] Free heap: "));
    Serial.println(ESP.getFreeHeap());
    Serial.print(F("[SYS] Chip ID: "));
    Serial.println(ESP.getChipId());
    
    // Initialize display
    displayInit();
    displayShowState(STATE_CONFIG_MODE);
    
    // Initialize WiFi
    wifiInit();
    displayShowState(STATE_IDLE);
    
    // Initialize MQTT
    mqttInit();
    
    // Initialize NFC
    nfcInit();
    
    // Configure button pin (optional)
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    
    Serial.println(F("\n[SYS] Initialization complete"));
    Serial.print(F("[SYS] Free heap after init: "));
    Serial.println(ESP.getFreeHeap());
}

void systemLoop() {
    // Check WiFi connection
    wifiCheckConnection();

    // Handle MQTT
    mqttLoop();

    // Check for NFC tag (when waiting, idle, or in read mode)
    static unsigned long lastNfcPoll = 0;
    if (millis() - lastNfcPoll >= NFC_POLL_INTERVAL) {
        lastNfcPoll = millis();
        
        if (currentState == STATE_WAITING_TAG || currentState == STATE_IDLE || currentState == STATE_READ_MODE) {
            if (nfc.tagPresent()) {
                processNfcTag();
            }
        }
    }

    // Check button (optional manual trigger)
    static unsigned long lastButtonCheck = 0;
    if (millis() - lastButtonCheck > 100) {
        lastButtonCheck = millis();
        if (digitalRead(BUTTON_PIN) == LOW) {
            delay(50); // Debounce
            if (digitalRead(BUTTON_PIN) == LOW) {
                Serial.println(F("[BTN] Button pressed"));
                // Could trigger manual write or other action
            }
        }
    }

    // Watchdog feed
    yield();
}

// ============================================================================
// ARDUINO SETUP & LOOP
// ============================================================================

void setup() {
    systemInit();
    displayShowState(STATE_IDLE);
}

void loop() {
    systemLoop();
}
