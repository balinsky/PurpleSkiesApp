import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { DatePickerInput } from 'react-native-paper-dates';

type Props = {
  label: string;
  value: string;       // YYYY-MM-DD or ''
  onChange: (v: string) => void;
  style?: object;
  year?: number;       // season year; corrects 2-digit-year input (e.g. 25 → 2025)
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

export default function DateInput({ label, value, onChange, style, year }: Props) {
  const InputRef       = useRef<any>(null);
  const RawTextRef     = useRef('');
  // True once the user types anything since the last clean state.
  const DirtyRef       = useRef(false);
  // True when the most recent onChange call returned a valid date.
  // onChangeText resets this to false; onChange sets it to true on success.
  // This works because react-native-paper-dates fires onChangeText (TextInput)
  // before it fires onChange (library callback).
  const ParsedValidRef = useRef(!!value);
  // Incrementing this key forces DatePickerInput to remount and reset its text.
  const [ResetKey, setResetKey] = useState(0);

  // Keep ParsedValidRef in sync when the parent loads an initial value.
  useEffect(() => {
    if (!DirtyRef.current) {
      ParsedValidRef.current = !!value;
    }
  }, [value]);

  function handleChange(d: Date | undefined) {
    if (d && d.getFullYear() < 100) {
      d = new Date(year ?? (2000 + d.getFullYear()), d.getMonth(), d.getDate());
    }
    if (d) {
      // onChange fires before onChangeText for the same keystroke; onChangeText resets
      // ParsedValidRef to false. Defer so our true wins after that reset.
      setTimeout(() => { ParsedValidRef.current = true; }, 0);
    } else {
      ParsedValidRef.current = false;
    }
    onChange(fromDate(d));
  }

  function handleChangeText(t: string | undefined) {
    DirtyRef.current    = true;
    RawTextRef.current  = t ?? '';
    ParsedValidRef.current = false; // reset; handleChange will set true if parse succeeds
  }

  function handleBlur() {
    if (!DirtyRef.current) return; // user never touched the field
    const trimmed = RawTextRef.current.trim();
    if (!trimmed) {
      // User cleared the field — save null
      DirtyRef.current       = false;
      ParsedValidRef.current = false;
      onChange('');
      return;
    }
    if (!ParsedValidRef.current) {
      // Text is present but couldn't be parsed — warn before discarding
      Alert.alert(
        'Incomplete date',
        `"${trimmed}" isn't a valid date. Keep editing or discard the change?`,
        [
          {
            text: 'Keep editing',
            // Brief delay lets the Alert finish animating out before focusing.
            onPress: () => setTimeout(() => InputRef.current?.focus(), 100),
          },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              DirtyRef.current       = false;
              ParsedValidRef.current = !!value;
              // Force the controlled input to remount with the unchanged value prop.
              setResetKey(k => k + 1);
            },
          },
        ],
      );
    } else {
      DirtyRef.current = false;
    }
  }

  return (
    <DatePickerInput
      key={ResetKey}
      ref={InputRef}
      locale="en"
      label={label}
      value={toDate(value)}
      onChange={handleChange}
      onChangeText={handleChangeText}
      onBlur={handleBlur}
      inputMode="start"
      mode="outlined"
      style={style}
    />
  );
}
