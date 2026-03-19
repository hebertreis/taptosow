# Stealth & Speed

## Product Overview

**The Pitch:** A high-velocity, field-ready mobile webapp for operators to bind physical NFC tags to digital QR identities. It integrates Firebase logging, Web NFC, and MQTT-based writing into a single, battery-efficient interface.

**For:** Field operators and technicians who need to provision hundreds of tags per shift in varying lighting conditions with zero UI friction.

**Device:** mobile

**Design Direction:** Stealth & Speed. Pure OLED black backgrounds, high-contrast monospace data readouts, and neon indicators. Utilitarian, brutalist, and built for uncompromised speed in the field.

**Inspired by:** Bloomberg Terminal, Matrix interfaces, Palantir Foundry mobile tools.

---

## Screens

- **Boot Sequence:** Context configuration (Tenant & Sector selection)
- **Acquisition (QR):** Full-screen barcode scanner to extract URL/tagId
- **Provisioning (NFC):** Hardware interface for writing data via Web NFC or MQTT
- **Telemetry (Logs):** Session history and sync status

---

## Key Flows

**Tag Binding Loop:** Rapid provision of a physical tag

1. User is on **Boot Sequence** -> sees dropdowns for Tenant/Sector
2. User clicks `[Initialize]` -> routes to **Acquisition**
3. User scans QR code -> auto-routes to **Provisioning**
4. User taps `[Write NFC]` -> holds phone to tag (Web NFC) or triggers MQTT ESP8266
5. Success ping -> auto-routes back to **Acquisition** for the next tag

---

<details>
<summary>Design System</summary>

## Color Palette

- **Primary:** `#00FF41` - Active buttons, success states, scanner reticle
- **Background:** `#000000` - Pure OLED black for maximum battery saving
- **Surface:** `#0A0A0A` - Elevated cards, sticky headers
- **Text:** `#FFFFFF` - Primary readings, active values
- **Muted:** `#4A4A4A` - Inactive states, borders, timestamps
- **Accent:** `#FF003C` - Critical errors, destructive actions, MQTT disconnects
- **Warning:** `#F5D300` - Pending states, writing in progress

## Typography

Industrial, machine-readable aesthetics.

- **Headings:** `Space Mono`, 700, 20-28px
- **Data Readouts:** `Space Mono`, 400, 16px
- **Body:** `Outfit`, 400, 16px
- **Small text:** `Outfit`, 400, 12px
- **Buttons:** `Space Mono`, 700, 14px, uppercase

**Style notes:** Hard edges (`0px` radius). Hairline borders (`1px solid #4A4A4A`). No drop shadows, only neon glows (`box-shadow: 0 0 8px #00FF41`) on active states. High-contrast, brutalist data density.

## Design Tokens

```css
:root {
  --color-primary: #00FF41;
  --color-background: #000000;
  --color-surface: #0A0A0A;
  --color-text: #FFFFFF;
  --color-muted: #4A4A4A;
  --color-error: #FF003C;
  --color-warning: #F5D300;
  --font-display: 'Space Mono', monospace;
  --font-body: 'Outfit', sans-serif;
  --radius: 0px;
  --border-thin: 1px solid var(--color-muted);
  --glow-success: 0 0 8px rgba(0, 255, 65, 0.4);
}
```

</details>

---

<details>
<summary>Screen Specifications</summary>

### Boot Sequence

**Purpose:** Set operational context before starting a batch.

**Layout:** Centered vertical stack, bottom-anchored action button.

**Key Elements:**
- **System Status:** Top right, `8px` pulsing dot (Green = Firebase connected, Red = Offline)
- **Tenant Selector:** Native `<select>`, `56px` height, `#000000` bg, `1px solid #4A4A4A`, `Space Mono` text
- **Sector Selector:** Appears after Tenant is selected, identical styling
- **Initialize Action:** `100%` width fixed bottom button, `#00FF41` text on `#000000`, `1px solid #00FF41`

**States:**
- **Empty:** Sector disabled until Tenant selected
- **Loading:** `[INITIALIZING...]` blinking text on button
- **Error:** Red border on selectors, `#FF003C` helper text below

**Components:**
- **Selector Input:** `100%` width, `16px` padding, white text, uppercase

**Interactions:**
- **Click Initialize:** Trigger Firebase auth verify, route to Acquisition, slide left animation

**Responsive:**
- **Mobile:** `100vw`, `100vh`, lock scroll

### Acquisition (QR)

**Purpose:** Optical data capture of the QR code.

**Layout:** Full bleed camera viewfinder, top overlay header, bottom telemetry drawer.

**Key Elements:**
- **Viewfinder:** Full screen, live video feed
- **Target Reticle:** `240x240px` square, `2px solid #00FF41` corners, center crosshair
- **Context Header:** `56px` height, `#0A0A0A` bg, displays active `[TENANT / SECTOR]`
- **Manual Entry:** Small floating text button bottom right `[MANUAL OVERRIDE]`

**States:**
- **Loading:** `[AWAITING CAMERA PERMISSION]` monospace text center screen
- **Error:** Black screen, red text `[CAMERA FAILED]`, button to retry

**Components:**
- **Reticle:** Animated corner brackets, pulsing opacity `0.5` to `1.0`

**Interactions:**
- **Scan Success:** Audible beep, reticle flashes solid `#00FF41`, instant route to Provisioning
- **Click Manual:** Opens modal with standard text input for TagID

**Responsive:**
- **Mobile:** Portrait lock, hide browser UI chrome

### Provisioning (NFC)

**Purpose:** Write acquired data to physical NFC tag.

**Layout:** Top status, center payload preview, bottom action grid.

**Key Elements:**
- **Payload Readout:** `120px` height card, `#0A0A0A` bg, displays raw extracted URL and TagID
- **Protocol Toggle:** Segmented control (`WEB NFC` | `MQTT`), `48px` height, active state gets neon glow
- **MQTT Status (if selected):** Displays discovered ESP8266 MAC/IP
- **Engage Action:** Huge `80px` height bottom button. `[HOLD TO TAG]` or `[TRANSMIT]`

**States:**
- **Empty:** Waiting for user trigger
- **Loading:** `[WRITING...]` yellow text, yellow border glow
- **Error:** Shake animation, button turns `#FF003C`, `[WRITE FAILED - RETRY]`

**Components:**
- **Data Readout:** `14px Space Mono`, word-break all, `1px solid #4A4A4A`

**Interactions:**
- **Tap Engage (Web NFC):** Triggers browser NFC prompt
- **Tap Engage (MQTT):** Fires MQTT publish, disables button until ACK received
- **Success:** Haptic feedback (vibration), full screen flashes `#00FF41`, auto-routes to Acquisition

**Responsive:**
- **Mobile:** Fills viewport, thumb-accessible primary button

### Telemetry (Logs)

**Purpose:** Verify shift progress and debug field issues.

**Layout:** Sticky top header with stats, scrollable list of events.

**Key Elements:**
- **Shift Stats:** `80px` header, `[SUCCESS: 42]` (green), `[FAILS: 1]` (red)
- **Log Feed:** Reverse chronological list of written tags
- **Log Item:** `64px` height, `#000000` bg, bottom border. Left: timestamp. Right: TagID. Status icon.
- **Clear/Export:** Floating action pill, bottom center

**States:**
- **Empty:** `[NO TELEMETRY RECORDED]` center screen
- **Loading:** Sequential skeleton lines, dark grey
- **Error:** Failed sync items show `#FF003C` background tint

**Components:**
- **Log Item:** `Space Mono 12px` timestamp (`#4A4A4A`), `Outfit 16px` ID (`#FFFFFF`)

**Interactions:**
- **Tap Log Item:** Expands to show full URL, Firebase push ID, and exact write method used
- **Tap Export:** Triggers native share sheet with CSV data

**Responsive:**
- **Mobile:** Smooth vertical scroll, stats remain sticky at top

</details>

---

<details>
<summary>Build Guide</summary>

**Stack:** HTML + Tailwind CSS v3

**Build Order:**
1. **Design System & Layout:** Setup `index.html` with Tailwind config, define exact colors and fonts. Establish absolute full-screen mobile layout (`h-screen w-screen overflow-hidden bg-black text-white`).
2. **Boot Sequence:** Establish the baseline form elements, native selects, and strict unrounded button styling.
3. **Provisioning (NFC):** Build the payload readout and protocol toggles. Simulates the core UI complexity before handling hardware APIs.
4. **Telemetry (Logs):** Build the scrolling list and sticky headers.
5. **Acquisition (QR):** Implement last, as it requires dropping in a JS library (e.g., HTML5-QRCode) and managing camera video feeds over the UI.

</details>