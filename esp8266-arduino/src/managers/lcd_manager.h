/**
 * @file lcd_manager.h
 * @brief LCD Display manager for OneTapGo
 * 
 * Handles SSD1306 OLED display with SPI/I2C coordination.
 * LCD updates are paused during NFC operations to avoid pin conflicts.
 */

#ifndef LCD_MANAGER_H
#define LCD_MANAGER_H

#include <ESP8266WiFi.h>
#include "core/system_state.h"

// ============================================================================
// LCD Manager Class
// ============================================================================
class LcdManager {
public:
    /**
     * Initialize LCD display
     * @return true if successful
     */
    bool begin();
    
    /**
     * Show current system state on display
     * Only updates if LCD is not paused for NFC
     */
    void showState();
    
    /**
     * Show a temporary message
     * @param title Message title
     * @param message Message content
     * @param duration Display duration in ms
     */
    void showMessage(const char* title, const char* message, unsigned long duration = 2000);
    
    /**
     * Show WiFi setup QR code info
     * @param ssid WiFi SSID
     * @param password WiFi password
     */
    void showQrCode(const char* ssid, const char* password);
    
    /**
     * Force display update (bypass cooldown)
     */
    void forceUpdate();
    
    /**
     * Check if LCD can update
     */
    bool canUpdate();
    
    /**
     * Get last update time
     */
    unsigned long getLastUpdateTime() { return _lastUpdate; }
    
private:
    unsigned long _lastUpdate = 0;
    bool _initialized = false;
    
    /**
     * Internal display rendering
     */
    void _renderState();
    
    /**
     * Restore SPI after I2C transaction
     */
    void _restoreSpi();
};

// ============================================================================
// Global LCD Manager Instance
// ============================================================================
extern LcdManager g_lcd;

#endif // LCD_MANAGER_H
