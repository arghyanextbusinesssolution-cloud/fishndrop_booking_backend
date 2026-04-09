import { Document, Schema, model } from "mongoose";

export interface ITable extends Document {
  tableNumber: number;
  capacity: 2 | 4;
  isAvailable: boolean;
}

const tableSchema = new Schema<ITable>(
  {
    tableNumber: { type: Number, required: true, unique: true },
    capacity: { type: Number, enum: [2, 4], required: true },
    isAvailable: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const Table = model<ITable>("Table", tableSchema);
export default Table;
