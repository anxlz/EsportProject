'use client';

import {
  CONTRACT_TEXT_FONTS,
  DEFAULT_CONTRACT_TEXT_STYLE,
  type ContractTextStyle,
} from '@esports/shared';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type CSSProperties } from 'react';
import { Button, SelectField, TextField } from '@/components/ui';

const PRESET_COLORS = ['#1c2321', '#0f5c4a', '#1d4ed8', '#7f1d1d', '#5b6662'] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const WEIGHT_LABELS = {
  300: '300',
  400: '400',
  500: '500',
  600: '600',
  700: '700',
  800: '800',
} as const;

type PreviewVariables = CSSProperties & {
  '--contract-font-family': string;
  '--contract-font-weight': number;
  '--contract-text-color': string;
};

function contrastRatio(color: string) {
  const luminance = (value: string) => {
    const channel = (offset: number) => {
      const component = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  return 1.05 / (luminance(color) + 0.05);
}

export function ContractTextStyleToolbar({
  style,
  onChange,
  onValidityChange,
  disabled,
}: {
  style: ContractTextStyle;
  onChange: (style: ContractTextStyle) => void;
  onValidityChange: (valid: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations('contracts.textStyle');
  const [hex, setHex] = useState(style.color);
  const [hexInvalid, setHexInvalid] = useState(false);
  const family = CONTRACT_TEXT_FONTS.find((item) => item.family === style.fontFamily)!;
  const ratio = contrastRatio(style.color);
  const previewStyle: PreviewVariables = {
    '--contract-font-family': `'${style.fontFamily}'`,
    '--contract-font-weight': style.fontWeight,
    '--contract-text-color': style.color,
  };

  useEffect(() => {
    setHex(style.color);
    setHexInvalid(false);
    onValidityChange(true);
  }, [onValidityChange, style.color]);

  const chooseColor = (color: string) => {
    setHex(color);
    setHexInvalid(false);
    onValidityChange(true);
    onChange({ ...style, color });
  };

  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t('title')}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setHex(DEFAULT_CONTRACT_TEXT_STYLE.color);
            setHexInvalid(false);
            onValidityChange(true);
            onChange({ ...DEFAULT_CONTRACT_TEXT_STYLE });
          }}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t('reset')}
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          label={t('fontFamily')}
          value={style.fontFamily}
          disabled={disabled}
          onChange={(event) => {
            const next = CONTRACT_TEXT_FONTS.find((item) => item.family === event.target.value);
            if (next)
              onChange({
                ...style,
                fontFamily: next.family,
                fontWeight: (next.weights as readonly number[]).includes(style.fontWeight)
                  ? style.fontWeight
                  : 400,
              });
          }}
        >
          {CONTRACT_TEXT_FONTS.map((font) => (
            <option key={font.family} value={font.family}>
              {font.family === 'IBM Plex Sans' ? t('latinFallback') : font.family}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('fontWeight')}
          value={String(style.fontWeight)}
          disabled={disabled}
          onChange={(event) => {
            const next = family.weights.find((weight) => weight === Number(event.target.value));
            if (next !== undefined) onChange({ ...style, fontWeight: next });
          }}
        >
          {family.weights.map((weight) => (
            <option key={weight} value={weight}>
              {t(`weights.${WEIGHT_LABELS[weight]}`)}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('color')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={t('presetColor', { color })}
                aria-pressed={style.color.toLowerCase() === color}
                disabled={disabled}
                onClick={() => chooseColor(color)}
                className="size-7 rounded-full border border-line-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                style={{ backgroundColor: color }}
              />
            ))}
            <input
              type="color"
              aria-label={t('customColor')}
              value={style.color}
              disabled={disabled}
              onChange={(event) => chooseColor(event.target.value)}
              className="size-8 cursor-pointer rounded border border-line bg-panel p-0.5 disabled:cursor-not-allowed"
            />
          </div>
          <TextField
            label={t('customHex')}
            dir="ltr"
            value={hex}
            disabled={disabled}
            error={hexInvalid ? t('invalidHex') : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setHex(next);
              const valid = HEX_COLOR.test(next);
              setHexInvalid(!valid);
              onValidityChange(valid);
              if (valid) onChange({ ...style, color: next });
            }}
          />
        </div>
      </div>
      {ratio < 4.5 && (
        <p role="status" className="mt-3 text-sm text-amber-ink">
          {t('contrastWarning', { ratio: ratio.toFixed(2) })}
        </p>
      )}
      <div
        className="contract-text-style-preview mt-4 rounded-md border border-line bg-white px-4 py-3"
        style={previewStyle}
        lang="ar"
        dir="rtl"
      >
        {t('previewSample')}
      </div>
    </section>
  );
}
