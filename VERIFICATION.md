# Verification Plan

## 1. Tag Tracking & Redirection (`redirectAuto`)
- **Initial Request**: Access `/a?tagId=test_tag_1`.
  - **Expectation**: If `test_tag_1` doesn't exist, it should be created in the `tags` collection with `access_count: 1`, `created_at`, `updated_at`, and `url` from `site_config/auto_redirect`.
- **Subsequent Request**: Access `/a?tagId=test_tag_1` again.
  - **Expectation**: `access_count` should increment to 2, and `updated_at` should update. `created_at` should remain the same.
- **Analytics**: Check `analytics_tags` collection.
  - **Expectation**: A new entry for each access with `ip`, `headers`, `os`, `referrer`, and `destinationUrl`.

## 2. Payment Audit (`createPaymentIntent`)
- **Request**: Send a POST request to `/createPaymentIntent`.
- **Analytics**: Check `analytics_payments` collection.
  - **Expectation**: A new entry with `paymentIntentId`, `amount`, `currency`, and `status`.

## 3. Manual Testing via Emulator
1. Run `firebase emulators:start`.
2. Use `curl` or Postman to trigger the functions.
3. Observe Firestore UI in the emulator to verify data persistence.
