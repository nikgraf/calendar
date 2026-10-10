import type { CalendarViewKind } from '@calendar/app-state';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import {
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
} from '../ui/icons.tsx';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';

const VIEWS: ReadonlyArray<{ label: string; value: 'day' | 'month' | 'week' }> = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
];

/**
 * The window's one toolbar: the drag region under the traffic lights,
 * the period title, navigation, the view switcher, search (⌘F, in the
 * side panel) and New (⌘N, or ⌘K straight into its quick-add field).
 * Everything else lives in the sidebar or the side panel.
 */
export function Toolbar({
  onNew,
  onSearch,
  onStep,
  onSwitchView,
  onToday,
  onTogglePanel,
  onToggleSidebar,
  panelShown,
  searchActive,
  sidebarCollapsed,
  title,
  view,
}: {
  onNew: () => void;
  /** Opens the search panel, or closes it when it is open. */
  onSearch: () => void;
  onStep: (direction: 1 | -1) => void;
  onSwitchView: (view: 'day' | 'month' | 'week') => void;
  onToday: () => void;
  /** The Today rail, shown or hidden (it hides by itself on a narrow window). */
  onTogglePanel: () => void;
  onToggleSidebar: () => void;
  panelShown: boolean;
  /** The panel shows search or a result opened from it. */
  searchActive: boolean;
  sidebarCollapsed: boolean;
  title: string;
  view: CalendarViewKind;
}) {
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  const unit = view === 'month' ? 'month' : view === 'day' ? 'day' : 'week';
  return (
    <header
      className="relative flex h-13 shrink-0 items-center gap-3 border-b border-hairline bg-surface-subtle pr-3.5 pl-[78px]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <IconButton
        active={!sidebarCollapsed}
        data-testid="sidebar-toggle"
        label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        onClick={onToggleSidebar}
        style={noDrag}
      >
        <SidebarIcon />
      </IconButton>
      <h1
        className="min-w-0 truncate text-[17px] font-semibold tracking-tight"
        data-testid="toolbar-title"
      >
        {title}
      </h1>
      <div className="flex items-center gap-0.5" style={noDrag}>
        <IconButton
          data-testid="nav-prev"
          label={`Previous ${unit}`}
          onClick={() => onStep(-1)}
          size="sm"
        >
          <ChevronLeftIcon />
        </IconButton>
        <Button data-testid="today" onClick={onToday} size="sm">
          Today
        </Button>
        <IconButton
          data-testid="nav-next"
          label={`Next ${unit}`}
          onClick={() => onStep(1)}
          size="sm"
        >
          <ChevronRightIcon />
        </IconButton>
      </div>
      <div className="flex-1" />
      <div style={noDrag}>
        <SegmentedControl
          label="View"
          onChange={onSwitchView}
          options={VIEWS.map((option) => ({
            label: option.label,
            testId: `view-${option.value}`,
            value: option.value,
          }))}
          size="sm"
          value={view === 'day' || view === 'month' ? view : 'week'}
        />
      </div>
      <IconButton
        active={searchActive}
        data-testid="search-toggle"
        label="Search (⌘F)"
        onClick={onSearch}
        style={noDrag}
      >
        <SearchIcon />
      </IconButton>
      <IconButton
        active={panelShown}
        data-testid="panel-toggle"
        label={panelShown ? 'Hide Today panel' : 'Show Today panel'}
        onClick={onTogglePanel}
        style={noDrag}
      >
        <CheckCircleIcon />
      </IconButton>
      <Button
        aria-label="New event"
        data-testid="new-event"
        onClick={onNew}
        style={noDrag}
        variant="primary"
      >
        <PlusIcon />
        New
      </Button>
    </header>
  );
}
