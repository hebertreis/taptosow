/**
 * @file lcd_manager.cpp
 * @brief LCD Display manager implementation
 */

#include "managers/lcd_manager.h"
#include "core/system_state.h"

LcdManager g_lcd;

// ============================================================================
// LCD Manager Implementation
// ============================================================================

bool LcdManager::begin() {
    // Initialize I2C
    Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
    
    // Initialize display
    if (!g_display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
        Serial.println(F("[LCD] SSD1306 allocation failed"));
        return false;
    }
    
    // Clear and show boot screen
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(0, 0);
    g_display.println(F("OneTapGo v" DEVICE_VERSION));
    g_display.println(F("Initializing..."));
    g_display.display();
    
    delay(500);
    
    // Restore SPI after I2C
    _restoreSpi();
    
    _initialized = true;
    _lastUpdate = millis();
    
    Serial.println(F("[LCD] Initialized successfully"));
    return true;
}

void LcdManager::showState() {
    if (!_initialized) return;
    
    // Check if LCD can update (not paused for NFC)
    if (!lcdCanUpdate()) {
        return;
    }
    
    // Check if enough time passed since last update
    if (millis() - _lastUpdate < LCD_UPDATE_INTERVAL_MS) {
        return;
    }
    
    _renderState();
    _lastUpdate = millis();
}

void LcdManager::showMessage(const char* title, const char* message, unsigned long duration) {
    if (!_initialized) return;
    
    g_display.clearDisplay();
    g_display.setCursor(0, 0);
    g_display.setTextSize(1);
    g_display.println(title);
    g_display.println();
    g_display.setTextSize(1);
    g_display.println(message);
    g_display.display();
    
    // Restore SPI after I2C
    _restoreSpi();
    
    delay(duration);
}

void LcdManager::showQrCode(const char* ssid, const char* password) {
    if (!_initialized) return;
    
    g_display.clearDisplay();
    g_display.setCursor(0, 0);
    g_display.setTextSize(1);
    g_display.println(F("WiFi Setup"));
    g_display.println();
    g_display.print(F("SSID: "));
    g_display.println(ssid);
    g_display.print(F("Pass: "));
    g_display.println(password);
    g_display.println();
    g_display.println(F("Connect & configure"));
    g_display.display();
    
    // Restore SPI after I2C
    _restoreSpi();
}

void LcdManager::forceUpdate() {
    if (!_initialized) return;
    _renderState();
    _lastUpdate = millis();
}

bool LcdManager::canUpdate() {
    return lcdCanUpdate();
}

void LcdManager::_renderState() {
    g_display.clearDisplay();
    g_display.setCursor(0, 0);
    
    // --- Header (y=0) ---
    g_display.setTextSize(1);
    g_display.print(F("OneTapGo"));
    g_display.setCursor(74, 0);
    g_display.print(F("v" DEVICE_VERSION));
    
    // Divider line (y=10)
    g_display.drawLine(0, 10, 127, 10, SSD1306_WHITE);
    
    // --- State line (y=12) ---
    g_display.setCursor(0, 12);
    switch (g_system.state) {
        case STATE_IDLE:
            if (!isDeviceReady()) {
                g_display.print(F("[~] Inicializando"));
            } else if (g_system.hasPendingWriteCommand) {
                g_display.print(F("[W] Aguardando tag"));
            } else if (g_system.readMode) {
                g_display.print(F("[R] Lendo tags"));
            } else {
                g_display.print(F("[S] Standby"));
            }
            break;
        case STATE_WAITING_TAG:
            g_display.print(F("[W] Aguardando tag..."));
            break;
        case STATE_TAG_DETECTED:
            g_display.print(F("[*] Tag detectada!"));
            break;
        case STATE_WRITING:
            g_display.print(F("[W] Gravando NDEF..."));
            break;
        case STATE_SUCCESS:
            g_display.print(F("[OK] Gravado! Retire"));
            break;
        case STATE_ERROR:
            g_display.print(F("[!!] Erro!"));
            break;
        case STATE_CONFIG_MODE:
            g_display.print(F("[AP] Config WiFi"));
            break;
        case STATE_READ_MODE:
            g_display.print(F("[R] Lendo tags"));
            break;
    }
    
    // --- WiFi status (y=24) ---
    g_display.setCursor(0, 24);
    if (g_system.isWifiConnected) {
        g_display.print(F("W+ "));
        String ssid = WiFi.SSID();
        if (ssid.length() > 10) ssid = ssid.substring(0, 10);
        g_display.print(ssid);
    } else {
        g_display.print(F("W- SEM WIFI"));
    }
    
    // --- MQTT + NFC status (y=36) ---
    g_display.setCursor(0, 36);
    g_display.print(F("M"));
    g_display.print(g_system.isMqttConnected ? F("+") : F("-"));
    g_display.print(F(" NFC"));
    g_display.print(g_system.isNfcConnected ? F("+") : F("-"));
    
    // Show NFC version if connected
    if (g_system.isNfcConnected && g_system.nfcFirmwareVersion != 0x00) {
        g_display.print(F(" v0x"));
        g_display.print(g_system.nfcFirmwareVersion, HEX);
    }
    
    // --- IP Address (y=48) ---
    g_display.setCursor(0, 48);
    if (g_system.isWifiConnected) {
        g_display.print(F("IP:"));
        g_display.print(WiFi.localIP().toString());
    }
    
    // --- RSSI bar (y=56) ---
    if (g_system.isWifiConnected) {
        int rssi = WiFi.RSSI();
        g_display.setCursor(0, 56);
        g_display.print(F("dBm:"));
        g_display.print(rssi);
        
        // Signal bars
        int bars = 0;
        if (rssi > -50) bars = 4;
        else if (rssi > -65) bars = 3;
        else if (rssi > -75) bars = 2;
        else if (rssi > -85) bars = 1;
        
        g_display.setCursor(68, 56);
        for (int b = 0; b < 4; b++) {
            g_display.print(b < bars ? F("|") : F("."));
        }
    }
    
    g_display.display();
    
    // Restore SPI after I2C transaction
    _restoreSpi();
}

void LcdManager::_restoreSpi() {
    // Small delay to ensure I2C is complete
    delayMicroseconds(I2C_TO_SPI_DELAY_US);
    
    // Re-initialize RC522 for SPI operations
    g_mfrc522.PCD_Init();
    g_mfrc522.PCD_SetAntennaGain(g_mfrc522.RxGain_max);
    delay(SPI_STABILIZE_DELAY_MS);
}
