import React from 'react';
import { DatePickerInput } from 'react-native-paper-dates';

type Props = {
  label: string;
  value: string;       // YYYY-MM-DD or ''
  onChange: (v: string) => void;
  style?: object;
};

function toDate(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

function fromDate(d: Date | undefined): string {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DateInput({ label, value, onChange, style }: Props) {
  return (
    <DatePickerInput
      locale="en"
      label={label}
      value={toDate(value)}
      onChange={(d) => onChange(fromDate(d))}
      inputMode="start"
      mode="outlined"
      style={style}
    />
  );
}
