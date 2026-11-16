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
}).unknown(true);
