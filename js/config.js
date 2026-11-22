// Address of the shared AI reader (the Cloudflare Worker in /worker).
// It holds the Gemini key, so nobody using the website needs one.
// Leave empty to disable; the app then reads bills on the phone.
export const SHARED_READER_URL = '';
