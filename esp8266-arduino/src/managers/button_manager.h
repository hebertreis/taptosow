/**
 * @file button_manager.h
 * @brief Flash button gesture manager
 */

#ifndef BUTTON_MANAGER_H
#define BUTTON_MANAGER_H

#include <Arduino.h>

enum ButtonEventType {
    BUTTON_EVENT_NONE,
    BUTTON_EVENT_SINGLE,
    BUTTON_EVENT_DOUBLE,
    BUTTON_EVENT_TRIPLE,
    BUTTON_EVENT_LONG_PRESS
};

class ButtonManager {
public:
    void begin();
    ButtonEventType loop();

private:
    bool _initialized = false;
    int _lastRawReading = HIGH;
    int _stableState = HIGH;
    bool _longPressReported = false;
    uint8_t _clickCount = 0;
    unsigned long _lastDebounceAt = 0;
    unsigned long _pressedAt = 0;
    unsigned long _sequenceDeadline = 0;
};

extern ButtonManager g_buttonManager;

#endif // BUTTON_MANAGER_H
