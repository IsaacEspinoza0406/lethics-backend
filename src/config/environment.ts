import * as Joi from 'joi';

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  MONGODB_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),
  JWT_ACCESS_SECRET_BASE64: Joi.string().required().custom((value: string, helpers) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value || new Set(bytes).size < 16) {
      return helpers.error('any.invalid');
    }
    return value;
  }).messages({ 'any.invalid': 'JWT_ACCESS_SECRET_BASE64 debe contener 32 bytes aleatorios codificados en base64' }),
  JWT_ACCESS_ISSUER: Joi.string().trim().required(),
  JWT_ACCESS_AUDIENCE: Joi.string().trim().required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(1).required(),
  VERIFICATION_CODE_HMAC_KEY_BASE64: Joi.string().required().custom((value: string, helpers) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value || new Set(bytes).size < 16 || value === helpers.state.ancestors[0].JWT_ACCESS_SECRET_BASE64) return helpers.error('any.invalid');
    return value;
  }).messages({ 'any.invalid': 'VERIFICATION_CODE_HMAC_KEY_BASE64 inválida o reutilizada' }),
  VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: Joi.number().integer().min(1).default(20),
  VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: Joi.number().integer().min(1).default(5),
  REDIS_URL: Joi.string().required().custom((value: string, helpers) => {
    try {
      const url = new URL(value);
      if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || !url.password || url.password === 'replace_me' || (helpers.state.ancestors[0].NODE_ENV === 'production' && url.protocol !== 'rediss:')) return helpers.error('any.invalid');
      return value;
    } catch { return helpers.error('any.invalid'); }
  }).messages({ 'any.invalid': 'REDIS_URL inválida o insegura' }),
  RATE_LIMIT_HMAC_KEY_BASE64: Joi.string().required().custom((value: string, helpers) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value || new Set(bytes).size < 16 || value === helpers.state.ancestors[0].JWT_ACCESS_SECRET_BASE64 || value === helpers.state.ancestors[0].VERIFICATION_CODE_HMAC_KEY_BASE64) return helpers.error('any.invalid');
    return value;
  }).messages({ 'any.invalid': 'RATE_LIMIT_HMAC_KEY_BASE64 inválida o reutilizada' }),
  RATE_LIMIT_NAMESPACE: Joi.when('NODE_ENV', { is: 'production', then: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,32}$/).invalid('development').required(), otherwise: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,32}$/).default('development') }),
  RATE_LIMIT_VERIFY_MAX: Joi.number().integer().min(1).default(60),
  RATE_LIMIT_VERIFY_WINDOW_SECONDS: Joi.number().integer().min(1).max(86400).default(600),
  RATE_LIMIT_REGISTER_MAX: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_REGISTER_WINDOW_SECONDS: Joi.number().integer().min(1).max(86400).default(3600),
  RATE_LIMIT_RESEND_MAX: Joi.number().integer().min(1).default(20),
  RATE_LIMIT_RESEND_WINDOW_SECONDS: Joi.number().integer().min(1).max(86400).default(3600),
}).unknown(true);
