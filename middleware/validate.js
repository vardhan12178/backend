import { validationResult } from 'express-validator';

/**
 * Middleware to check express-validator results.
 * Use after validation chains in route definitions:
 *   router.post('/route', [body('x').isString()], validate, handler)
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

export default validate;
