/**
 * @file status_led_manager.h
 * @brief Built-in status LED manager
 */

#ifndef STATUS_LED_MANAGER_H
#define STATUS_LED_MANAGER_H

#include <Arduino.h>

class StatusLedManager {
public:
    void begin();
    void loop();
    void signalActivity();
    void setHold(bool enabled);

private:
    bool _initialized = false;
    bool _holdEnabled = false;
    bool _ledOn = false;
    uint8_t _pendingTransitions = 0;
    unsigned long _lastTransitionAt = 0;

    void _apply(bool enabled);
};

extern StatusLedManager g_statusLed;

#endif // STATUS_LED_MANAGER_H
