import { body } from "express-validator";

export const createBookingValidator = [
  body("partySize").isInt({ min: 2, max: 8 }).withMessage("Party size must be between 2 and 8"),
  body("bookingDate")
    .isISO8601()
    .withMessage("Booking date must be a valid ISO date")
    .custom((value) => {
      const bookingDate = new Date(value);
      if (Number.isNaN(bookingDate.getTime()) || bookingDate <= new Date()) {
        throw new Error("Booking date must be in the future");
      }
      return true;
    }),
  body("bookingTime").isString().trim().notEmpty().withMessage("Booking time is required"),
  body("customerName").isString().trim().isLength({ min: 2, max: 100 }).withMessage("Name is required"),
  body("customerEmail").isEmail().withMessage("Valid email is required"),
  body("customerPhone").isString().trim().isLength({ min: 7, max: 20 }).withMessage("Valid phone is required"),
  body("occasion")
    .isIn(["birthday", "anniversary", "business", "quiet", "graduation", "other"])
    .withMessage("Occasion must be birthday, anniversary, business, quiet, graduation, or other"),
  body("notes").optional().isString().trim().isLength({ max: 500 }).withMessage("Notes must be up to 500 characters"),
  body("cakeDetails")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Cake details must be up to 500 characters"),
  body("cakePrice").optional().isFloat({ min: 0 }).withMessage("Cake price must be 0 or greater"),
  body("password")
    .optional()
    .isString()
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
];
