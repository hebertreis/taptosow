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
    void begin();
    void loop();

    static Coordinator& getInstance() {
        static Coordinator instance;
        return instance;
    }

private:
    Coordinator() = default;
    ~Coordinator() = default;

    Coordinator(const Coordinator&) = delete;
    Coordinator& operator=(const Coordinator&) = delete;

    void _syncIdleState();
    void _handleNfcJob();
    void _handleLegacyReadMode();
    void _prepareActiveJob();
    void _completeNfcSuccess(const NfcCardInfo& card);
    void _completeNfcError(const String& error);
    void _handleNfcTimeout();
    void _finishJob(DeviceState finalState);
    bool _jobTimedOut(unsigned long now) const;

    unsigned long _observedJobStartedAt = 0;
    unsigned long _legacyCooldownUntil = 0;
};

#endif // COORDINATOR_H
