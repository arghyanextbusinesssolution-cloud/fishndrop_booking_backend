import { body } from "express-validator";

export const createBookingValidator = [
  body("partySize").isInt({ min: 2, max: 8 }).withMessage("Party size must be between 2 and 8"),
  body("bookingDate")
    .isISO8601()
    .withMessage("Booking date must be a valid ISO date")
    .custom((value) => {
      const parts = value.split("T")[0].split("-");
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const bookingDay = new Date(year, month, day);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (bookingDay < today) {
          throw new Error("Booking date cannot be in the past");
        }
      } else {
        const bookingDate = new Date(value);
        if (Number.isNaN(bookingDate.getTime())) {
          throw new Error("Booking date must be a valid date");
        }
      }
      return true;
    }),
  body("bookingTime").isString().trim().notEmpty().withMessage("Booking time is required"),
  body("customerName")
    .optional({ checkFalsy: true })
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Name must be between 2 and 100 characters"),
  body("customerEmail")
    .optional({ checkFalsy: true })
    .isEmail()
    .withMessage("Valid email is required"),
  body("customerPhone").isString().trim().isLength({ min: 7, max: 20 }).withMessage("Valid phone is required"),
  body("occasion")
    .optional({ checkFalsy: true })
    .isString()
    .trim(),
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
