/**
 * @file lcd_manager.cpp
 * @brief LCD display manager implementation
 */

#include <cstring>

#include "managers/lcd_manager.h"
#include "core/system_state.h"

LcdManager g_lcd;

namespace {
constexpr int kHeaderHeight = 10;
constexpr int kHeaderTextY = 1;
constexpr int kBodyStartY = 16;

void prepareI2cForDisplay() {
    Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
    delayMicroseconds(I2C_TO_SPI_DELAY_US);
}

String truncateText(const String& value, size_t maxLen) {
    if (value.length() <= maxLen) {
        return value;
    }
    return value.substring(0, maxLen - 1) + ".";
}

String formatWifiSignal(int rssi) {
    if (rssi > -50) return "||||";
    if (rssi > -65) return "|||.";
    if (rssi > -75) return "||..";
    if (rssi > -85) return "|...";
    return "....";
}

String nfcHardwareLabel() {
    if (!g_system.isNfcConnected) {
        return "INIT ERR";
    }

    String label = "OK";
    label += String(g_system.nfcFirmwareVersion, HEX);
    label.toUpperCase();
    return label;
}

String stateSummary() {
    return deviceStateName((DeviceState)g_system.state);
}

String lastOperationSummary() {
    if (g_system.nfcJob.active) {
        return String("JOB ") + nfcCommandName(g_system.nfcJob.command);
    }

    if (g_system.lastCompletedCommand != NFC_CMD_NONE) {
        return String("LAST ") + nfcCommandName(g_system.lastCompletedCommand);
    }

    if (g_system.lastErrorCode.length() > 0) {
        return String("ERR ") + truncateText(g_system.lastErrorCode, 15);
    }

    return "NFC OK";
}
}

bool LcdManager::begin() {
#if !LCD_ENABLED
    _initialized = false;
    Serial.println(F("[LCD] Disabled by configuration"));
    return false;
#else
    prepareI2cForDisplay();

    if (!g_display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
        Serial.println(F("[LCD] SSD1306 allocation failed"));
        return false;
    }

    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);
    g_display.setTextWrap(false);
    g_display.setCursor(20, 18);
    g_display.print(F("OneTapGo"));
    g_display.setCursor(20, 30);
    g_display.print(F("Inicializando..."));
    g_display.setCursor(84, 54);
    g_display.print(F("v"));
    g_display.print(DEVICE_VERSION);
    g_display.display();

    _initialized = true;
    _lastUpdate = millis();
    _lastState = STATE_BOOT;

    Serial.println(F("[LCD] Initialized successfully"));
    return true;
#endif
}

void LcdManager::showState() {
    if (!_initialized || !lcdCanUpdate()) {
        return;
    }

    DeviceState currentState = (DeviceState)g_system.state;
    unsigned long now = millis();

    if (currentState == _lastState && (now - _lastUpdate) < LCD_UPDATE_INTERVAL_MS) {
        return;
    }

    prepareI2cForDisplay();

    switch (currentState) {
        case STATE_BOOT:
            _renderBootScreen();
            break;
        case STATE_WIFI_SETUP:
            _renderWifiSetup();
            break;
        case STATE_NFC_WAITING:
            _renderWaiting();
            break;
        case STATE_NFC_ACTIVE:
            _renderProcessing();
            break;
        case STATE_SUCCESS:
            _renderSuccess();
            break;
        case STATE_ERROR:
            _renderError();
            break;
        case STATE_IDLE:
        default:
            _renderDashboard();
            break;
    }

    g_display.display();

    _lastUpdate = now;
    _lastState = currentState;
}

void LcdManager::forceUpdate() {
    if (!_initialized || !lcdCanUpdate()) {
        return;
    }

    _lastUpdate = 0;
    showState();
}

void LcdManager::showMessage(const char* title, const char* message, unsigned long duration) {
    if (!_initialized) {
        return;
    }

    prepareI2cForDisplay();
    _showCenteredMessage(title, message, true);

    if (duration > 0) {
        delay(duration);
    }
}

void LcdManager::showQrCode(const char* ssid, const char* password) {
    if (!_initialized) {
        return;
    }

    prepareI2cForDisplay();
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, 12, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(26, 2);
    g_display.print(F("WiFi Setup"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(0, 18);
    g_display.print(F("AP: "));
    g_display.println(ssid);
    g_display.print(F("Senha: "));
    g_display.println(password);
    g_display.setCursor(0, 46);
    g_display.print(F("Acesse 192.168.4.1"));

    g_display.display();
}

bool LcdManager::canUpdate() {
    return lcdCanUpdate();
}

void LcdManager::_renderBootScreen() {
    g_display.clearDisplay();
    g_display.setTextSize(2);
    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(14, 18);
    g_display.print(F("OneTapGo"));

    g_display.setTextSize(1);
    g_display.setCursor(20, 40);
    g_display.print(F("Inicializando..."));
    g_display.setCursor(92, 54);
    g_display.print(F("v"));
    g_display.print(DEVICE_VERSION);
}

void LcdManager::_renderDashboard() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);
    g_display.setTextWrap(false);

    g_display.fillRect(0, 0, 128, kHeaderHeight, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(2, kHeaderTextY);
    g_display.print(F("OneTapGo "));
    g_display.print(DEVICE_VERSION);

    g_display.setTextColor(SSD1306_WHITE);

    if (g_system.isWifiConnected) {
        g_display.setCursor(0, kBodyStartY);
        g_display.print(F("WiFi: "));
        g_display.print(truncateText(g_system.wifiSsid, 15));

        g_display.setCursor(0, 26);
        g_display.print(F("IP: "));
        g_display.print(g_system.wifiIp);
    } else {
        g_display.setCursor(0, kBodyStartY);
        g_display.print(F("AP: "));
        g_display.print(truncateText(g_system.portalApSsid, 15));

        g_display.setCursor(0, 26);
        g_display.print(F("Senha: "));
        g_display.print(truncateText(g_system.portalApPassword, 12));
    }

    g_display.setCursor(0, 36);
    g_display.print(F("ST: "));
    g_display.print(truncateText(stateSummary(), 12));

    g_display.setCursor(0, 46);
    g_display.print(F("MQTT: "));
    g_display.print(g_system.isMqttConnected ? F("OK") : F("OFF"));
    g_display.print(F(" NFC: "));
    g_display.print(nfcHardwareLabel());

    g_display.setCursor(0, 56);
    if (g_system.nfcJob.active) {
        g_display.print(F("JOB: "));
        g_display.print(nfcCommandName(g_system.nfcJob.command));
    } else if (g_system.lastCompletedCommand != NFC_CMD_NONE) {
        g_display.print(truncateText(lastOperationSummary(), 21));
    } else {
        g_display.print(F("RSSI: "));
        if (g_system.isWifiConnected) {
            g_display.print(g_system.wifiRssi);
            g_display.print(F(" "));
            g_display.print(formatWifiSignal(g_system.wifiRssi));
        } else {
            g_display.print(F("-- ...."));
        }
    }
}

void LcdManager::_renderWifiSetup() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, kHeaderHeight, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(24, kHeaderTextY);
    g_display.print(F("WiFi Setup"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(0, kBodyStartY);
    g_display.print(F("AP: "));
    g_display.println(g_system.portalApSsid);
    g_display.print(F("Senha: "));
    g_display.println(g_system.portalApPassword);
    g_display.setCursor(0, 40);
    g_display.print(F("Conecte e configure"));
    g_display.setCursor(0, 52);
    g_display.print(F("192.168.4.1"));
}

void LcdManager::_renderWaiting() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, kHeaderHeight, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(34, kHeaderTextY);
    g_display.print(F("NFC Job"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setTextSize(2);
    g_display.setCursor(4, 18);
    g_display.print(F("APROXIME"));
    g_display.setCursor(18, 36);
    g_display.print(F("O TAG"));

    g_display.setTextSize(1);
    g_display.setCursor(0, 56);
    g_display.print(nfcCommandName(g_system.nfcJob.command));
    g_display.print(F(" timeout "));
    unsigned long timeoutSec = g_system.nfcJob.timeoutMs / 1000UL;
    g_display.print(timeoutSec);
    g_display.print(F("s"));
}

void LcdManager::_renderProcessing() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, kHeaderHeight, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(30, kHeaderTextY);
    g_display.print(F("Processando"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setTextSize(2);
    g_display.setCursor(4, 22);
    g_display.print(F("NFC EM"));
    g_display.setCursor(4, 40);
    g_display.print(F("USO"));
}

void LcdManager::_renderSuccess() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(28, 4);
    g_display.print(F("SUCESSO"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(0, 22);
    NfcCommandType command = g_system.nfcJob.active ? g_system.nfcJob.command : g_system.lastCompletedCommand;
    if (command == NFC_CMD_WRITE) {
        g_display.print(F("URL gravada"));
    } else {
        g_display.print(F("Leitura enviada"));
    }

    g_display.setCursor(0, 34);
    g_display.print(F("UID: "));
    g_display.print(truncateText(g_system.lastCard.uid, 18));

    g_display.setCursor(0, 46);
    if (command == NFC_CMD_WRITE) {
        g_display.print(F("Gravacao OK"));
    } else {
        g_display.print(F("NDEF: "));
        g_display.print(g_system.lastCard.hasNdef ? F("OK") : F("SEM"));
    }
}

void LcdManager::_renderError() {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    g_display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
    g_display.setTextColor(SSD1306_BLACK);
    g_display.setCursor(40, 4);
    g_display.print(F("ERRO"));

    g_display.setTextColor(SSD1306_WHITE);
    g_display.setCursor(0, 20);
    g_display.print(truncateText(g_system.lastErrorCode, 21));
    g_display.setCursor(0, 34);
    g_display.print(truncateText(g_system.lastErrorMessage, 21));
    g_display.setCursor(0, 48);
    g_display.print(truncateText(g_system.lastErrorSource, 21));
}

void LcdManager::_showCenteredMessage(const char* title, const char* message, bool invertTitle) {
    g_display.clearDisplay();
    g_display.setTextSize(1);
    g_display.setTextColor(SSD1306_WHITE);

    if (title && title[0] != '\0') {
        if (invertTitle) {
            g_display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
            g_display.setTextColor(SSD1306_BLACK);
        }
        int titleLen = strlen(title) * 6;
        int titleX = titleLen < 128 ? (128 - titleLen) / 2 : 0;
        g_display.setCursor(titleX, 3);
        g_display.print(title);
        g_display.setTextColor(SSD1306_WHITE);
    }

    int y = title && title[0] != '\0' ? 24 : 16;
    const char* cursor = message;
    while (*cursor != '\0' && y < 56) {
        const char* lineEnd = strchr(cursor, '\n');
        size_t lineLen = lineEnd ? static_cast<size_t>(lineEnd - cursor) : strlen(cursor);
        String line = String(cursor).substring(0, lineLen);
        int lineLenPx = static_cast<int>(line.length()) * 6;
        int lineX = lineLenPx < 128 ? (128 - lineLenPx) / 2 : 0;
        g_display.setCursor(lineX, y);
        g_display.print(line);
        y += 10;
        if (!lineEnd) {
            break;
        }
        cursor = lineEnd + 1;
    }

    g_display.display();
}
