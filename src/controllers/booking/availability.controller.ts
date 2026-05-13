import { NextFunction, Request, Response } from "express";
import { sanitizeString } from "../../utils/time.utils";
import * as BookingService from "../../services/booking";

export const getAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const date = sanitizeString(req.query.date);
    const slot = sanitizeString(req.query.slot);
    const allowSplit = req.query.allowSplit === "true";
    const partySize = Math.max(Number(req.query.partySize) || 2, 2);
    
    const { slots, allTables } = await BookingService.getStandardAvailability(date, partySize, allowSplit);

    const slotData = slot ? slots.find((s) => s.slot === slot) : undefined;
    const selectedTableIds = slotData?.assignedTableIds || [];
    const bookedForSelectedSlot = slotData?.bookedTableIds || [];

    const layout = allTables.map((table) => {
      const id = table._id.toString();
      let state: "available" | "booked" | "selected" | "locked" = "available";
      if (!table.isAvailable) state = "locked";
      else if (bookedForSelectedSlot.includes(id)) state = "booked";
      else if (selectedTableIds.includes(id)) state = "selected";
      
      return {
        _id: id,
        tableNumber: table.tableNumber,
        capacity: table.capacity,
        state
      };
    });

    res.status(200).json({
      success: true,
      date,
      partySize,
      slots: slots.map(({ bookedTableIds, assignedTableIds, ...rest }) => rest),
      layout
    });
  } catch (error) {
    next(new Error("Failed to fetch availability"));
  }
};
