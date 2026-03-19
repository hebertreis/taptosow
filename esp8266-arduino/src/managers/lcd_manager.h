/**
 * @file lcd_manager.h
 * @brief LCD display manager for OneTapGo
 */

#ifndef LCD_MANAGER_H
#define LCD_MANAGER_H

#include <ESP8266WiFi.h>
#include "core/system_state.h"

class LcdManager {
public:
    bool begin();
    void showState();
    void forceUpdate();
    void showMessage(const char* title, const char* message, unsigned long duration = 1500);
    void showQrCode(const char* ssid, const char* password);
    bool canUpdate();

    unsigned long getLastUpdateTime() { return _lastUpdate; }

private:
    bool _initialized = false;
    unsigned long _lastUpdate = 0;
    DeviceState _lastState = STATE_BOOT;

    void _renderBootScreen();
    void _renderDashboard();
    void _renderWifiSetup();
    void _renderWaiting();
    void _renderProcessing();
    void _renderSuccess();
    void _renderError();
    void _showCenteredMessage(const char* title, const char* message, bool invertTitle = false);
};

extern LcdManager g_lcd;

#endif // LCD_MANAGER_H
