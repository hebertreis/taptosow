/**
 * @file lcd_manager.h
 * @brief LCD display manager for OneTapGo
 */

#ifndef LCD_MANAGER_H
#define LCD_MANAGER_H

#include <ESP8266WiFi.h>
#include "core/system_state.h"

enum LcdOverlayType {
    LCD_OVERLAY_NONE,
    LCD_OVERLAY_MESSAGE,
    LCD_OVERLAY_ADMIN,
    LCD_OVERLAY_TECHNICAL
};

class LcdManager {
public:
    bool begin();
    void showState();
    void forceUpdate();
    void showMessage(const char* title, const char* message, unsigned long duration = 1500);
    void showQrCode(const char* ssid, const char* password);
    void showAdminOverlay(unsigned long duration = LCD_OVERLAY_DURATION_MS);
    void showTechnicalOverlay(unsigned long duration = 0);
    bool canUpdate();

    unsigned long getLastUpdateTime() { return _lastUpdate; }

private:
    bool _initialized = false;
    unsigned long _lastUpdate = 0;
    DeviceState _lastState = STATE_BOOT;
    LcdOverlayType _overlayType = LCD_OVERLAY_NONE;
    unsigned long _overlayUntil = 0;
    String _messageTitle = "";
    String _messageBody = "";

    void _renderBootScreen();
    void _renderDashboard();
    void _renderWifiSetup();
    void _renderWaiting();
    void _renderProcessing();
    void _renderSuccess();
    void _renderError();
    void _renderAdminOverlay();
    void _renderTechnicalOverlay();
    void _renderMessageOverlay();
    void _setOverlay(LcdOverlayType type, unsigned long duration);
    void _showCenteredMessage(const char* title, const char* message, bool invertTitle = false);
};

extern LcdManager g_lcd;

#endif // LCD_MANAGER_H
