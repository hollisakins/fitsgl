// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

/**
 * The standalone display controls exported for hosts building custom chrome
 * (D11's "narrow public API" applies to the core barrel; these ride the /react
 * subpath). Rendering happens outside `<FitsExplorer>`, so each control must
 * self-inject the stylesheet and work from props alone.
 */
import {
  Knob,
  TrilogyControls,
  TrilogyWeightMatrix,
  defaultExplorerState,
  type ExplorerBand,
} from '../../src/react/index.js';
import { DEFAULT_TRILOGY_PARAMS } from '../../src/index.js';

const band = (name: string, gridGroup = 0): ExplorerBand => ({
  name,
  tiles: [`/${name}/manifest.json`],
  gridGroup,
});
const BANDS: ExplorerBand[] = [band('f115w'), band('f277w'), band('f444w')];

describe('standalone controls (host-embeddable)', () => {
  it('Knob renders as an accessible slider and self-injects styles', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Knob value={0.25} color="#f00" label="R weight" onChange={onChange} />);
    const knob = getByRole('slider', { name: 'R weight' });
    expect(knob.getAttribute('aria-valuenow')).toBe('25');
    expect(document.getElementById('fgl-explorer-styles')).not.toBeNull();
    fireEvent.keyDown(knob, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith(0.26);
  });

  it('TrilogyControls emits param patches from its sliders', () => {
    const onChange = vi.fn();
    const { container } = render(
      <TrilogyControls params={{ ...DEFAULT_TRILOGY_PARAMS }} missing={false} onChange={onChange} />,
    );
    const sliders = container.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(4); // noiselum / satpercent / noisesig / noisesig0
    fireEvent.change(sliders[0]!, { target: { value: '0.5' } });
    expect(onChange).toHaveBeenCalledWith({ noiselum: 0.5 });
  });

  it('TrilogyWeightMatrix lists group bands and applies a toggled composite', () => {
    const onApply = vi.fn();
    const state = defaultExplorerState(BANDS, { mode: 'rgb', stretch: 'trilogy' });
    const { getByLabelText } = render(
      <TrilogyWeightMatrix bands={[...BANDS]} state={state} onApply={onApply} onRainbow={() => {}} />,
    );
    // untick a participating band (the fallback composite is the rgb triple)
    fireEvent.click(getByLabelText('include f115w'));
    expect(onApply).toHaveBeenCalled();
    const entries = onApply.mock.calls[0]![0] as Array<{ band: string }>;
    expect(entries.some((e) => e.band === 'f115w')).toBe(false);
  });
});
