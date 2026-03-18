/**
 * @file coordinator.h
 * @brief System coordinator for OneTapGo
 * 
 * Coordinates operations between NFC, LCD, and MQTT to avoid
 * SPI/I2C pin conflicts.
 */

#ifndef COORDINATOR_H
#define COORDINATOR_H

#include "core/system_state.h"
#include "managers/nfc_manager.h"
#include "managers/lcd_manager.h"
#include "managers/mqtt_manager.h"
#include "managers/wifi_manager.h"

// ============================================================================
// Coordinator Class
// ============================================================================
class Coordinator {
public:
    /**
     * Initialize all systems
     */
    void begin();
    
    /**
     * Main loop handler
     * - Process MQTT
     * - Poll NFC (with coordination)
     * - Update LCD (when not paused)
     * - Handle WiFi reconnection
     */
    void loop();
    
    /**
     * Check NFC timeout and notify if expired
     */
    void checkNfcTimeout();
    
    /**
     * Get coordinator instance
     */
    static Coordinator& getInstance() {
        static Coordinator instance;
        return instance;
    }
    
private:
    Coordinator() = default;
    ~Coordinator() = default;
    
    // Prevent copying
    Coordinator(const Coordinator&) = delete;
    Coordinator& operator=(const Coordinator&) = delete;
    
    /**
     * Handle NFC operations based on current mode
     */
    void handleNfcOperations();
    
    /**
     * Process detected tag
     */
    void processTag();
    
    /**
     * Write tag with pending command
     */
    void writeTag();
    
    /**
     * Read tag and publish data
     */
    void readTag();
};

#endif // COORDINATOR_H
