import { body } from "express-validator";

export const registerValidator = [
  body("name").notEmpty().withMessage("Name is required").trim().escape().isLength({ max: 50 }).withMessage("Name must be at most 50 characters"),
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
    .withMessage("Password must include at least one uppercase letter, one number, and one special character")
];

export const loginValidator = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required")
];
