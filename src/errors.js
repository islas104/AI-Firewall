/** Consistent OpenAI-style error envelope used across all routes. */
export function errorBody(message, type = 'proxy_error') {
  return { error: { message, type } };
}
