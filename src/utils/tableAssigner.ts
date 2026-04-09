import Table, { ITable } from "../models/Table";

interface AssignResult {
  tables: ITable[];
  totalAmount: number;
  complimentaryDrinks: number;
  error?: string;
}

const PRICE_PER_PERSON = 40;

const assignTables = async (partySize: number, blockedTableIds: string[] = []): Promise<AssignResult> => {
  if (partySize === 1) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "Single person bookings are not allowed" };
  }

  if (partySize < 2) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "Party size must be at least 2" };
  }

  const availableTables = await Table.find({
    isAvailable: true,
    _id: { $nin: blockedTableIds }
  })
    .sort({ tableNumber: 1 })
    .lean<ITable[]>();

  const tableCount = availableTables.length;
  if (tableCount === 0) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "No available tables for this slot" };
  }

  let selected: ITable[] | null = null;
  let bestWaste = Number.POSITIVE_INFINITY;
  let bestTablesUsed = Number.POSITIVE_INFINITY;

  for (let mask = 1; mask < 1 << tableCount; mask += 1) {
    const subset: ITable[] = [];
    let baseCapacity = 0;
    let hasFourSeater = false;
    for (let index = 0; index < tableCount; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        const table = availableTables[index];
        subset.push(table);
        baseCapacity += table.capacity;
        if (table.capacity === 4) {
          hasFourSeater = true;
        }
      }
    }

    // Business rule: allow one extra chair if at least one 4-seater exists.
    const effectiveCapacity = baseCapacity + (hasFourSeater ? 1 : 0);
    if (effectiveCapacity < partySize) {
      continue;
    }

    const waste = effectiveCapacity - partySize;
    const usesFewerTables = subset.length < bestTablesUsed;
    const betterWaste = waste < bestWaste;

    if (betterWaste || (waste === bestWaste && usesFewerTables)) {
      selected = subset;
      bestWaste = waste;
      bestTablesUsed = subset.length;
    }
  }

  if (!selected) {
    return { tables: [], totalAmount: 0, complimentaryDrinks: 0, error: "No suitable tables available for this party size" };
  }

  return {
    tables: selected,
    totalAmount: partySize * PRICE_PER_PERSON,
    complimentaryDrinks: selected.length * 2
  };
};

export default assignTables;
