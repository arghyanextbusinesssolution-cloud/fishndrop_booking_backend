import Table, { ITable } from "../models/Table";
import DailyTableLock from "../models/DailyTableLock";

interface AssignResult {
  tables: ITable[];
  totalAmount: number;
  complimentaryDrinks: number;
  error?: string;
  code?: string;
}

const PRICE_PER_PERSON = 40;
const NO_TABLE_ERROR = "Sir for this time and date no table is available";

const assignTables = async (
  partySize: number,
  bookingDate: string,
  blockedTableIds: string[] = [],
  allowSplit: boolean = false
): Promise<AssignResult> => {
  // Rule: 1 person not allowed (min 2)
  if (partySize < 2) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "Minimum 2 guests required for online booking" };
  }

  if (partySize > 8) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "Our online system supports up to 8 guests. For larger parties, please contact us." };
  }

  const start = new Date(bookingDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(bookingDate);
  end.setHours(23, 59, 59, 999);

  const dailyLocks = await DailyTableLock.find({
    date: { $gte: start, $lte: end },
    isLocked: true
  });
  const lockedTableIds = dailyLocks.map(l => l.table.toString());

  const availableTables = await Table.find({
    isAvailable: true, // Master lock must be open
    _id: { $nin: [...blockedTableIds, ...lockedTableIds] }
  })
    .sort({ tableNumber: 1 })
    .lean<ITable[]>();

  const twoSeaters = availableTables.filter((t) => t.capacity === 2);
  const fourSeaters = availableTables.filter((t) => t.capacity === 4);

  let selected: ITable[] = [];

  switch (partySize) {
    case 2:
      // Rule: 2 person two seater table
      if (twoSeaters.length >= 1) {
        selected = [twoSeaters[0]];
      }
      break;

    case 3:
    case 4:
    case 5:
      // Rule: 3/4 person four seater. 5 person also uses four seater (with extra chair consent on frontend)
      if (fourSeaters.length >= 1) {
        selected = [fourSeaters[0]];
      }
      break;

    case 6:
      // Rule: 6 persona thjen 4 seater one and two seater one
      if (fourSeaters.length >= 1 && twoSeaters.length >= 1) {
        selected = [fourSeaters[0], twoSeaters[0]];
      }
      break;

    case 7:
    case 8:
      // Rule: 7/8 person two four seater
      if (fourSeaters.length >= 2) {
        selected = [fourSeaters[0], fourSeaters[1]];
      }
      break;
  }

  if (selected.length === 0) {
    return { 
      tables: [], 
      totalAmount: 0, 
      complimentaryDrinks: 0, 
      error: NO_TABLE_ERROR 
    };
  }

  return {
    tables: selected,
    totalAmount: partySize * PRICE_PER_PERSON,
    complimentaryDrinks: selected.length * 2
  };
};

export default assignTables;
