using System.Diagnostics;
using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Serialization;

namespace HypixelProxy.App;

public sealed class MainForm : Form
{
    private static readonly Icon? WindowIcon = LoadWindowIcon();
    private static readonly Color AppBg = Color.FromArgb(244, 246, 248);
    private static readonly Color Surface = Color.White;
    private static readonly Color SurfaceAlt = Color.FromArgb(238, 242, 246);
    private static readonly Color SurfaceMuted = Color.FromArgb(247, 249, 251);
    private static readonly Color TextStrong = Color.FromArgb(27, 31, 36);
    private static readonly Color TextMuted = Color.FromArgb(99, 112, 131);
    private static readonly Color Border = Color.FromArgb(215, 221, 229);
    private static readonly Color BorderSoft = Color.FromArgb(226, 231, 238);
    private static readonly Color Accent = Color.FromArgb(15, 123, 108);
    private static readonly Color AccentSoft = Color.FromArgb(229, 246, 242);
    private static readonly Color Blue = Color.FromArgb(36, 87, 197);
    private static readonly Color Danger = Color.FromArgb(179, 54, 54);
    private static readonly Color Charcoal = Color.FromArgb(64, 73, 84);
    private static readonly Color TerminalBg = Color.FromArgb(15, 23, 31);
    private static readonly Color TerminalText = Color.FromArgb(219, 231, 242);
    private const int HeaderHeight = 124;
    private const int MainHeight = 276;
    private const int MaxContentWidth = 1180;
    private const int MaxContentHeight = 820;

    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly System.Windows.Forms.Timer refreshTimer = new() { Interval = 1500 };
    private readonly string rootDir;
    private readonly Uri dashboardUri;
    private readonly TableLayoutPanel rootLayout = new();

    private ProxyStatus? lastStatus;
    private Process? proxyProcess;
    private bool routeChanging;
    private bool splitChanging;
    private bool closingConfirmed;
    private bool logsExpanded;
    private bool qolDrawerOpen;

    private readonly StatusBadge statusBadge = new();
    private readonly Label routingHint = MutedLabel("Ready for next connection");
    private readonly RouteCard directRoute = new()
    {
        RouteId = "direct",
        Title = "Direct",
        Address = "mc.hypixel.net:25565",
        Description = "Minecraft proxy -> Hypixel"
    };
    private readonly RouteCard stopTheLagRoute = new()
    {
        RouteId = "stopthelag",
        Title = "StopTheLag",
        Address = "chi1.qtx.stopthelag.lol:25566",
        Description = "Minecraft proxy -> StopTheLag -> Hypixel"
    };
    private readonly ModernButton startButton = ModernButton.Primary("Start", Accent);
    private readonly ModernButton stopButton = ModernButton.Primary("Stop", Danger);
    private readonly ModernButton restartButton = ModernButton.Secondary("Restart");
    private readonly ModernButton qolMenuButton = ModernButton.Secondary("QoL");
    private readonly ModernButton closeQolButton = ModernButton.Ghost("Close");
    private readonly ModernButton expandLogsButton = ModernButton.Secondary("Expand");
    private readonly ToggleSwitch splitToggle = new();
    private readonly TerminalLogView logsView = new();
    private readonly RoundedPanel qolDrawer = new() { Radius = 12, FillColor = Surface, BorderColor = Border };
    private readonly RoundedPanel authPanel = new() { Radius = 8, FillColor = Color.FromArgb(230, 249, 244), BorderColor = Color.FromArgb(122, 207, 185) };
    private readonly LinkLabel authUrl = new();
    private readonly TextBox authCode = new();
    private readonly ModernButton openBrowserButton = ModernButton.Secondary("Open browser");
    private readonly ModernButton copyCodeButton = ModernButton.Primary("Copy code", Accent);
    private Control? mainArea;

    public MainForm()
    {
        rootDir = FindRootDirectory();
        dashboardUri = ReadDashboardUri(rootDir);

        Text = "Hypixel Proxy";
        if (WindowIcon is not null) Icon = WindowIcon;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1040, 720);
        Size = new Size(1220, 780);
        Font = new Font("Segoe UI", 10f);
        BackColor = AppBg;
        DoubleBuffered = true;

        BuildUi();

        refreshTimer.Tick += async (_, _) => await RefreshStatusAsync();
        Shown += async (_, _) =>
        {
            refreshTimer.Start();
            await RefreshStatusAsync();
        };
        FormClosing += async (_, e) =>
        {
            if (closingConfirmed || lastStatus is null) return;
            e.Cancel = true;
            var close = MessageBox.Show(
                "Stoppa Hypixel Proxy innan appen stangs?",
                "Hypixel Proxy",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question);

            if (close == DialogResult.Cancel) return;
            if (close == DialogResult.Yes) await StopProxyAsync();
            refreshTimer.Stop();
            closingConfirmed = true;
            BeginInvoke(Close);
        };
    }

    private void BuildUi()
    {
        rootLayout.Dock = DockStyle.None;
        rootLayout.ColumnCount = 1;
        rootLayout.RowCount = 3;
        rootLayout.Padding = new Padding(0);
        rootLayout.BackColor = AppBg;
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, HeaderHeight));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, MainHeight));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(rootLayout);

        mainArea = BuildMainArea();
        rootLayout.Controls.Add(BuildTopBar(), 0, 0);
        rootLayout.Controls.Add(mainArea, 0, 1);
        rootLayout.Controls.Add(BuildLogsCard(), 0, 2);
        BuildQolDrawer();
        Controls.Add(qolDrawer);
        LayoutRoot();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        LayoutRoot();
    }

    private void LayoutRoot()
    {
        if (rootLayout.Parent is null) return;

        var width = Math.Min(ClientSize.Width - 56, MaxContentWidth);
        var height = Math.Min(ClientSize.Height - 44, MaxContentHeight);
        width = Math.Max(width, 960);
        height = Math.Max(height, 660);
        rootLayout.Bounds = new Rectangle(
            Math.Max(28, (ClientSize.Width - width) / 2),
            Math.Max(18, (ClientSize.Height - height) / 2),
            width,
            height);

        var drawerWidth = Math.Min(372, Math.Max(336, width / 3));
        qolDrawer.Bounds = new Rectangle(
            rootLayout.Right - drawerWidth,
            rootLayout.Top + HeaderHeight,
            drawerWidth,
            rootLayout.Height - HeaderHeight);
        if (qolDrawer.Visible) qolDrawer.BringToFront();
    }

    private Control BuildTopBar()
    {
        var top = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = new Padding(0, 0, 0, 24) };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 270));

        top.BackColor = AppBg;

        var brand = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = AppBg };
        brand.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        brand.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        brand.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        top.Controls.Add(brand, 0, 0);

        var mark = new LogoMark { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 8, 0) };
        brand.Controls.Add(mark, 0, 0);

        var copy = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, BackColor = AppBg };
        copy.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        copy.RowStyles.Add(new RowStyle(SizeType.Absolute, 39));
        copy.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        brand.Controls.Add(copy, 1, 0);

        copy.Controls.Add(new Label
        {
            Text = "Hypixel Proxy",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 21.5f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.BottomLeft,
            AutoEllipsis = false
        }, 0, 0);
        copy.Controls.Add(new Label
        {
            Text = "Local Minecraft proxy launcher",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 9.5f),
            ForeColor = TextMuted,
            TextAlign = ContentAlignment.TopLeft
        }, 0, 1);

        var actions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = AppBg };
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 132));
        actions.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        actions.Margin = new Padding(0, 10, 0, 10);

        qolMenuButton.Margin = new Padding(0, 9, 12, 9);
        qolMenuButton.Click += (_, _) => SetQolDrawerVisible(!qolDrawerOpen);
        actions.Controls.Add(qolMenuButton, 0, 0);

        statusBadge.Dock = DockStyle.Fill;
        statusBadge.Margin = new Padding(0, 9, 0, 9);
        statusBadge.Width = 132;
        actions.Controls.Add(statusBadge, 1, 0);
        top.Controls.Add(actions, 1, 0);
        return top;
    }

    private Control BuildMainArea()
    {
        var area = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, BackColor = AppBg };
        area.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 66));
        area.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));

        area.Controls.Add(BuildLeftColumn(), 0, 0);
        area.Controls.Add(BuildControlColumn(), 1, 0);
        return area;
    }

    private Control BuildLeftColumn()
    {
        var column = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 1, BackColor = AppBg };
        column.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        column.Controls.Add(BuildRoutingCard(), 0, 0);
        return column;
    }

    private Control BuildRoutingCard()
    {
        var card = Card();
        card.Margin = new Padding(0, 0, 16, 14);
        card.Padding = new Padding(18, 16, 18, 16);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(0),
            BackColor = Surface
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 126));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        card.Controls.Add(layout);

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, BackColor = Surface };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
        header.Controls.Add(new Label
        {
            Text = "Routing",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 14.5f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);
        routingHint.Dock = DockStyle.Fill;
        routingHint.TextAlign = ContentAlignment.MiddleRight;
        header.Controls.Add(routingHint, 1, 0);
        layout.Controls.Add(header, 0, 0);

        var routeGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(0, 6, 0, 8), BackColor = Surface };
        routeGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        routeGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        directRoute.Margin = new Padding(0, 0, 8, 0);
        stopTheLagRoute.Margin = new Padding(8, 0, 0, 0);
        directRoute.Click += async (_, _) => await SetRouteAsync("direct");
        stopTheLagRoute.Click += async (_, _) => await SetRouteAsync("stopthelag");
        routeGrid.Controls.Add(directRoute, 0, 0);
        routeGrid.Controls.Add(stopTheLagRoute, 1, 0);
        layout.Controls.Add(routeGrid, 0, 1);

        var footer = new Label
        {
            Text = "Minecraft always connects to the local proxy. Route changes restart the proxy automatically.",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 9.5f),
            ForeColor = TextMuted,
            TextAlign = ContentAlignment.TopLeft,
            Padding = new Padding(0, 8, 0, 0)
        };
        layout.Controls.Add(footer, 0, 2);
        return card;
    }

    private Control BuildControlColumn()
    {
        var column = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, BackColor = AppBg };
        column.RowStyles.Add(new RowStyle(SizeType.Absolute, 184));
        column.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var controlsCard = Card();
        controlsCard.Padding = new Padding(16);
        controlsCard.Margin = new Padding(0, 0, 0, 14);
        var controls = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, BackColor = Surface };
        controls.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        controls.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        controls.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        controls.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        controls.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        controls.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        controlsCard.Controls.Add(controls);

        controls.Controls.Add(new Label
        {
            Text = "Controls",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 14.5f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);
        controls.SetColumnSpan(controls.Controls[0], 2);

        startButton.Margin = new Padding(0, 3, 6, 3);
        stopButton.Margin = new Padding(6, 3, 0, 3);
        restartButton.Margin = new Padding(0, 3, 0, 3);
        startButton.Click += async (_, _) => await StartProxyAsync();
        stopButton.Click += async (_, _) => await StopProxyAsync();
        restartButton.Click += async (_, _) => await RestartProxyAsync();
        controls.Controls.Add(startButton, 0, 1);
        controls.Controls.Add(stopButton, 1, 1);
        controls.Controls.Add(restartButton, 0, 2);
        controls.SetColumnSpan(restartButton, 2);

        column.Controls.Add(controlsCard, 0, 0);
        return column;
    }

    private void BuildQolDrawer()
    {
        qolDrawer.Padding = new Padding(18);
        qolDrawer.Visible = false;
        qolDrawer.Anchor = AnchorStyles.Top | AnchorStyles.Right | AnchorStyles.Bottom;
        qolDrawer.BackColor = Surface;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 184));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.BackColor = Surface;
        qolDrawer.Controls.Add(layout);

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        header.BackColor = Surface;
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 84));
        header.Controls.Add(new Label
        {
            Text = "QoL",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 15f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);
        closeQolButton.Margin = new Padding(0, 7, 0, 7);
        closeQolButton.Click += (_, _) => SetQolDrawerVisible(false);
        header.Controls.Add(closeQolButton, 1, 0);
        layout.Controls.Add(header, 0, 0);

        var splitCard = new RoundedPanel
        {
            Dock = DockStyle.Fill,
            FillColor = SurfaceAlt,
            BorderColor = BorderSoft,
            Radius = 8,
            Padding = new Padding(16),
            Margin = new Padding(0, 8, 0, 14),
            BackColor = SurfaceAlt
        };
        var splitLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, BackColor = SurfaceAlt };
        splitLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        splitLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
        splitLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        splitCard.Controls.Add(splitLayout);

        var splitHeader = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, BackColor = SurfaceAlt };
        splitHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        splitHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 56));
        splitHeader.Controls.Add(new Label
        {
            Text = "Split reminder",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 11.5f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);
        splitToggle.Dock = DockStyle.Right;
        splitToggle.Margin = new Padding(0, 4, 0, 4);
        splitToggle.CheckedChanged += async (_, _) =>
        {
            if (splitChanging) return;
            await SetSplitReminderEnabledAsync(splitToggle.Checked);
        };
        splitHeader.Controls.Add(splitToggle, 1, 0);
        splitLayout.Controls.Add(splitHeader, 0, 0);

        splitLayout.Controls.Add(new Label
        {
            Text = "Change RESPAWNED to SPLIT if a teammate dies during your respawn countdown.",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 9.25f),
            ForeColor = TextMuted,
            TextAlign = ContentAlignment.TopLeft
        }, 0, 1);

        layout.Controls.Add(splitCard, 0, 1);

        var empty = new RoundedPanel
        {
            Dock = DockStyle.Fill,
            FillColor = SurfaceMuted,
            BorderColor = BorderSoft,
            Radius = 8,
            Padding = new Padding(16),
            Margin = new Padding(0),
            BackColor = SurfaceMuted
        };
        empty.Controls.Add(new Label
        {
            Text = "More QoL tools will appear here later.",
            Dock = DockStyle.Top,
            Height = 42,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = TextMuted,
            TextAlign = ContentAlignment.MiddleLeft
        });
        layout.Controls.Add(empty, 0, 2);
    }

    private Control BuildLogsCard()
    {
        var card = Card();
        card.Margin = new Padding(0);
        card.Padding = new Padding(18, 16, 18, 18);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, Padding = new Padding(0), BackColor = Surface };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        card.Controls.Add(layout);

        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, BackColor = Surface };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108));
        header.Controls.Add(new Label
        {
            Text = "Logs",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 14.5f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);
        var scope = new Label
        {
            Text = "Control log",
            Dock = DockStyle.Fill,
            ForeColor = TextMuted,
            TextAlign = ContentAlignment.MiddleRight,
            Font = new Font("Segoe UI", 9.5f)
        };
        header.Controls.Add(scope, 1, 0);
        expandLogsButton.Margin = new Padding(10, 6, 0, 6);
        expandLogsButton.Click += (_, _) => ToggleLogsExpanded();
        header.Controls.Add(expandLogsButton, 2, 0);
        layout.Controls.Add(header, 0, 0);

        BuildAuthPanel();
        layout.Controls.Add(authPanel, 0, 1);

        logsView.Dock = DockStyle.Fill;
        logsView.Margin = new Padding(0, 8, 0, 0);
        layout.Controls.Add(logsView, 0, 2);
        return card;
    }

    private void BuildAuthPanel()
    {
        authPanel.Dock = DockStyle.Fill;
        authPanel.Padding = new Padding(16, 12, 16, 12);
        authPanel.Margin = new Padding(0, 6, 0, 8);
        authPanel.Visible = false;
        authPanel.BackColor = Color.FromArgb(230, 249, 244);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 2, BackColor = Color.FromArgb(230, 249, 244) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 136));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        authPanel.Controls.Add(layout);

        layout.Controls.Add(new Label
        {
            Text = "Microsoft",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 0);

        authUrl.Dock = DockStyle.Fill;
        authUrl.TextAlign = ContentAlignment.MiddleLeft;
        authUrl.LinkColor = Blue;
        authUrl.ActiveLinkColor = Accent;
        authUrl.LinkClicked += (_, _) => OpenUrl(authUrl.Text);
        layout.Controls.Add(authUrl, 1, 0);

        openBrowserButton.Margin = new Padding(8, 0, 0, 6);
        copyCodeButton.Margin = new Padding(8, 6, 0, 0);
        openBrowserButton.Click += (_, _) => OpenUrl(authUrl.Text);
        copyCodeButton.Click += (_, _) => CopyText(authCode.Text);
        layout.Controls.Add(openBrowserButton, 2, 0);

        layout.Controls.Add(new Label
        {
            Text = "Code",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = TextStrong,
            TextAlign = ContentAlignment.MiddleLeft
        }, 0, 1);

        authCode.Dock = DockStyle.Fill;
        authCode.ReadOnly = true;
        authCode.Font = new Font("Cascadia Mono", 15f, FontStyle.Bold);
        authCode.TextAlign = HorizontalAlignment.Center;
        authCode.BorderStyle = BorderStyle.FixedSingle;
        authCode.BackColor = Color.White;
        layout.Controls.Add(authCode, 1, 1);
        layout.Controls.Add(copyCodeButton, 2, 1);
    }

    private static RoundedPanel Card() => new()
    {
        Dock = DockStyle.Fill,
        FillColor = Surface,
        BorderColor = Border,
        Radius = 8,
        BackColor = AppBg
    };

    private async Task RefreshStatusAsync()
    {
        var status = await TryGetStatusAsync();
        lastStatus = status;
        RenderStatus(status);
    }

    private void RenderStatus(ProxyStatus? status)
    {
        if (status is null)
        {
            statusBadge.SetState(routeChanging ? "Restarting" : "Stopped", routeChanging);
            routingHint.Text = routeChanging ? "Restarting proxy..." : "Start proxy to select route";
            startButton.Enabled = !routeChanging;
            stopButton.Enabled = false;
            restartButton.Enabled = !routeChanging;
            directRoute.Enabled = false;
            stopTheLagRoute.Enabled = false;
            splitToggle.Enabled = false;
            if (!routeChanging) logsView.LogText = "Proxy is not running.";
            authPanel.Visible = false;
            SetAuthHeight(0);
            return;
        }

        statusBadge.SetState(routeChanging ? "Restarting" : "Running", true);
        routingHint.Text = routeChanging ? "Restarting proxy..." : status.ActiveSessions > 0 ? "New connections only" : "Ready for next connection";
        startButton.Enabled = false;
        stopButton.Enabled = !routeChanging;
        restartButton.Enabled = !routeChanging;
        directRoute.Enabled = !routeChanging;
        stopTheLagRoute.Enabled = !routeChanging;
        splitToggle.Enabled = !routeChanging;

        foreach (var route in status.Routes)
        {
            var target = route.Id == "stopthelag" ? stopTheLagRoute : directRoute;
            target.Title = route.Name ?? route.Id ?? "";
            target.Address = $"{route.Host}:{route.Port}";
            target.Description = route.Description ?? "";
            target.Selected = route.Id == status.Route?.Id;
        }

        splitChanging = true;
        splitToggle.Checked = status.SplitReminder?.Enabled ?? true;
        splitChanging = false;

        logsView.LogText = BuildLogs(status.Logs);
        RenderAuth(status.Logs);
    }

    private void SetQolDrawerVisible(bool visible)
    {
        if (visible && logsExpanded)
        {
            logsExpanded = false;
            if (mainArea is not null) mainArea.Visible = true;
            rootLayout.RowStyles[1].Height = MainHeight;
            expandLogsButton.Text = "Expand";
            expandLogsButton.Invalidate();
        }

        qolDrawerOpen = visible;
        qolDrawer.Visible = visible;
        qolMenuButton.Selected = visible;
        qolMenuButton.Invalidate();
        if (visible) qolDrawer.BringToFront();
    }

    private void ToggleLogsExpanded()
    {
        logsExpanded = !logsExpanded;
        if (mainArea is not null) mainArea.Visible = !logsExpanded;
        rootLayout.RowStyles[1].Height = logsExpanded ? 0 : MainHeight;
        expandLogsButton.Text = logsExpanded ? "Collapse" : "Expand";
        expandLogsButton.Invalidate();

        if (logsExpanded)
        {
            SetQolDrawerVisible(false);
        }
    }

    private void SetAuthHeight(int height)
    {
        if (authPanel.Parent is TableLayoutPanel layout)
        {
            layout.RowStyles[1].Height = height;
        }
    }

    private static string BuildLogs(IReadOnlyList<LogEntry> logs)
    {
        if (logs.Count == 0) return "No logs yet.";
        var builder = new StringBuilder();
        foreach (var log in logs)
        {
            builder.Append('[').Append(log.Time).Append("] ").Append(log.Label).Append(" > ").Append(log.Message).AppendLine();
        }
        return builder.ToString();
    }

    private void RenderAuth(IReadOnlyList<LogEntry> logs)
    {
        LogEntry? auth = null;
        for (var i = logs.Count - 1; i >= 0; i--)
        {
            var log = logs[i];
            if (IsMicrosoftAuthComplete(log)) break;
            if (log.Kind == "microsoft_auth")
            {
                auth = log;
                break;
            }
        }

        if (auth is null)
        {
            authPanel.Visible = false;
            SetAuthHeight(0);
            return;
        }

        authPanel.Visible = true;
        SetAuthHeight(102);
        authUrl.Text = auth.Url ?? "";
        authCode.Text = auth.Code ?? "";
    }

    private static bool IsMicrosoftAuthComplete(LogEntry log)
    {
        if (string.Equals(log.Kind, "microsoft_auth_complete", StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.Equals(log.Label, "Microsoft", StringComparison.OrdinalIgnoreCase)) return false;

        var message = log.Message ?? "";
        return message.StartsWith("Sign-in complete", StringComparison.OrdinalIgnoreCase)
            || message.StartsWith("Sign in complete", StringComparison.OrdinalIgnoreCase)
            || message.StartsWith("Signed in", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<ProxyStatus?> TryGetStatusAsync()
    {
        try
        {
            return await http.GetFromJsonAsync<ProxyStatus>(new Uri(dashboardUri, "/api/status"));
        }
        catch
        {
            return null;
        }
    }

    private async Task SetRouteAsync(string routeId)
    {
        if (routeChanging) return;
        if (string.Equals(lastStatus?.Route?.Id, routeId, StringComparison.OrdinalIgnoreCase)) return;

        routeChanging = true;
        directRoute.Selected = routeId == "direct";
        stopTheLagRoute.Selected = routeId == "stopthelag";
        statusBadge.SetState("Restarting", true);
        routingHint.Text = "Restarting proxy...";
        startButton.Enabled = false;
        stopButton.Enabled = false;
        restartButton.Enabled = false;
        directRoute.Enabled = false;
        stopTheLagRoute.Enabled = false;
        splitToggle.Enabled = false;

        try
        {
            using var response = await http.PostAsJsonAsync(new Uri(dashboardUri, "/api/route"), new { routeId });
            response.EnsureSuccessStatusCode();
            await RestartProxyAsync();
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Could not change route", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            routeChanging = false;
            await RefreshStatusAsync();
        }
    }

    private async Task SetSplitReminderEnabledAsync(bool enabled)
    {
        try
        {
            using var response = await http.PostAsJsonAsync(new Uri(dashboardUri, "/api/split-reminder"), new { enabled });
            response.EnsureSuccessStatusCode();
            await RefreshStatusAsync();
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Could not update split reminder", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task StartProxyAsync()
    {
        if (await TryGetStatusAsync() is not null)
        {
            await RefreshStatusAsync();
            return;
        }

        var scriptPath = Path.Combine(rootDir, "start.ps1");
        if (!File.Exists(scriptPath))
        {
            MessageBox.Show("Could not find start.ps1.", "Hypixel Proxy", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        proxyProcess = Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\" -App",
            WorkingDirectory = rootDir,
            WindowStyle = ProcessWindowStyle.Hidden,
            CreateNoWindow = true,
            UseShellExecute = false
        });

        statusBadge.SetState("Starting", true);
        for (var i = 0; i < 60; i++)
        {
            await Task.Delay(500);
            var status = await TryGetStatusAsync();
            if (status is not null)
            {
                lastStatus = status;
                RenderStatus(status);
                return;
            }
        }

        MessageBox.Show("Proxy did not answer on the local control API.", "Hypixel Proxy", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        await RefreshStatusAsync();
    }

    private async Task StopProxyAsync()
    {
        try
        {
            if (await TryGetStatusAsync() is not null)
            {
                using var response = await http.PostAsync(new Uri(dashboardUri, "/api/shutdown"), null);
                response.EnsureSuccessStatusCode();
            }
        }
        catch
        {
        }

        for (var i = 0; i < 20; i++)
        {
            await Task.Delay(250);
            if (await TryGetStatusAsync() is null) break;
        }

        if (proxyProcess is { HasExited: false })
        {
            try
            {
                proxyProcess.Kill(entireProcessTree: true);
            }
            catch
            {
            }
        }

        lastStatus = null;
        RenderStatus(null);
    }

    private async Task RestartProxyAsync()
    {
        await StopProxyAsync();
        await StartProxyAsync();
    }

    private static void OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private static void CopyText(string text)
    {
        if (!string.IsNullOrWhiteSpace(text)) Clipboard.SetText(text);
    }

    private static Uri ReadDashboardUri(string rootDir)
    {
        var host = "127.0.0.1";
        var port = "25765";
        var envPath = Path.Combine(rootDir, ".env");
        if (File.Exists(envPath))
        {
            foreach (var line in File.ReadAllLines(envPath))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith('#') || !trimmed.Contains('=')) continue;
                var parts = trimmed.Split('=', 2);
                if (parts[0].Equals("DASHBOARD_HOST", StringComparison.OrdinalIgnoreCase)) host = parts[1].Trim();
                if (parts[0].Equals("DASHBOARD_PORT", StringComparison.OrdinalIgnoreCase)) port = parts[1].Trim();
            }
        }

        return new Uri($"http://{host}:{port}");
    }

    private static string FindRootDirectory()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json")) && Directory.Exists(Path.Combine(dir.FullName, "src")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }

        return AppContext.BaseDirectory;
    }

    private static Label Label(string text, float size, FontStyle style, Color color, ContentAlignment alignment) => new()
    {
        Text = text,
        Dock = DockStyle.Fill,
        Font = new Font("Segoe UI", size, style),
        ForeColor = color,
        TextAlign = alignment
    };

    private static Label MutedLabel(string text) => Label(text, 9.5f, FontStyle.Regular, TextMuted, ContentAlignment.MiddleLeft);

    private static Color PaintBackColor(Control control)
    {
        var color = control.Parent?.BackColor ?? AppBg;
        return color == Color.Transparent ? AppBg : color;
    }

    private static Icon? LoadWindowIcon()
    {
        using var stream = typeof(MainForm).Assembly.GetManifestResourceStream("HypixelProxy.App.Assets.HypixelProxyLogo.ico");
        if (stream is null) return null;

        using var icon = new Icon(stream);
        return (Icon)icon.Clone();
    }

    private sealed class ProxyStatus
    {
        [JsonPropertyName("localAddress")]
        public string? LocalAddress { get; set; }

        [JsonPropertyName("activeSessions")]
        public int ActiveSessions { get; set; }

        [JsonPropertyName("route")]
        public RouteInfo? Route { get; set; }

        [JsonPropertyName("routes")]
        public List<RouteInfo> Routes { get; set; } = [];

        [JsonPropertyName("splitReminder")]
        public SplitReminderInfo? SplitReminder { get; set; }

        [JsonPropertyName("logs")]
        public List<LogEntry> Logs { get; set; } = [];
    }

    private sealed class SplitReminderInfo
    {
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }
    }

    private sealed class RouteInfo
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("host")]
        public string? Host { get; set; }

        [JsonPropertyName("port")]
        public int Port { get; set; }

        [JsonPropertyName("description")]
        public string? Description { get; set; }
    }

    private sealed class LogEntry
    {
        [JsonPropertyName("time")]
        public string? Time { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("message")]
        public string? Message { get; set; }

        [JsonPropertyName("kind")]
        public string? Kind { get; set; }

        [JsonPropertyName("url")]
        public string? Url { get; set; }

        [JsonPropertyName("code")]
        public string? Code { get; set; }
    }

    private class RoundedPanel : Panel
    {
        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public int Radius { get; set; } = 8;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public Color FillColor { get; set; } = Surface;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public Color BorderColor { get; set; } = Border;

        public RoundedPanel()
        {
            DoubleBuffered = true;
            BackColor = AppBg;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var path = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Radius);
            using var fill = new SolidBrush(FillColor);
            using var border = new Pen(BorderColor);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);
        }
    }

    private sealed class ModernButton : Control
    {
        private readonly Color fillColor;
        private readonly Color textColor;
        private readonly Color borderColor;
        private bool hovering;
        private bool selected;

        private ModernButton(string text, Color fillColor, Color textColor, Color borderColor)
        {
            this.fillColor = fillColor;
            this.textColor = textColor;
            this.borderColor = borderColor;
            Text = text;
            Dock = DockStyle.Fill;
            Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            ForeColor = textColor;
            Cursor = Cursors.Hand;
            BackColor = AppBg;
            DoubleBuffered = true;
            TabStop = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.UserPaint, true);
        }

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public bool Selected
        {
            get => selected;
            set
            {
                if (selected == value) return;
                selected = value;
                Invalidate();
            }
        }

        public static ModernButton Primary(string text, Color color) => new(text, color, Color.White, color);

        public static ModernButton Secondary(string text) => new(text, Surface, TextStrong, Border);

        public static ModernButton Ghost(string text) => new(text, SurfaceMuted, TextStrong, BorderSoft);

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovering = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (Enabled && (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter))
            {
                e.Handled = true;
                PerformClick();
            }

            base.OnKeyDown(e);
        }

        private void PerformClick()
        {
            OnClick(EventArgs.Empty);
        }

        protected override void OnPaint(PaintEventArgs pevent)
        {
            pevent.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            pevent.Graphics.Clear(PaintBackColor(this));
            var baseFill = selected ? AccentSoft : fillColor;
            var baseBorder = selected ? Accent : borderColor;
            var baseText = selected ? Accent : textColor;
            var paintFill = Enabled ? (hovering ? ControlPaint.Light(baseFill, .08f) : baseFill) : Color.FromArgb(229, 234, 241);
            var paintBorder = Enabled ? baseBorder : Color.FromArgb(218, 225, 234);
            var paintText = Enabled ? baseText : Color.FromArgb(128, 140, 155);
            using var path = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), 7);
            using var brush = new SolidBrush(paintFill);
            using var border = new Pen(Focused ? Accent : paintBorder, Focused ? 1.6f : 1f);
            pevent.Graphics.FillPath(brush, path);
            pevent.Graphics.DrawPath(border, path);
            TextRenderer.DrawText(pevent.Graphics, Text, Font, ClientRectangle, paintText, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    private sealed class ToggleSwitch : Control
    {
        private bool hovering;
        private bool isChecked;

        public event EventHandler? CheckedChanged;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public bool Checked
        {
            get => isChecked;
            set
            {
                if (isChecked == value) return;
                isChecked = value;
                Invalidate();
                CheckedChanged?.Invoke(this, EventArgs.Empty);
            }
        }

        public ToggleSwitch()
        {
            Width = 48;
            Height = 28;
            BackColor = AppBg;
            Cursor = Cursors.Hand;
            DoubleBuffered = true;
            TabStop = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.UserPaint, true);
        }

        protected override void OnMouseEnter(EventArgs eventargs)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(eventargs);
        }

        protected override void OnMouseLeave(EventArgs eventargs)
        {
            hovering = false;
            Invalidate();
            base.OnMouseLeave(eventargs);
        }

        protected override void OnClick(EventArgs e)
        {
            if (Enabled) Checked = !Checked;
            base.OnClick(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (Enabled && (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter))
            {
                e.Handled = true;
                Checked = !Checked;
            }

            base.OnKeyDown(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnPaint(PaintEventArgs pevent)
        {
            pevent.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            pevent.Graphics.Clear(PaintBackColor(this));
            var track = new Rectangle(2, 4, Width - 4, Height - 8);
            var active = Enabled && Checked;
            var trackColor = !Enabled
                ? Color.FromArgb(190, 198, 208)
                : active
                    ? (hovering ? ControlPaint.Light(Accent, .12f) : Accent)
                    : Color.FromArgb(169, 180, 193);

            using var trackPath = RoundedRect(track, track.Height / 2);
            using var trackBrush = new SolidBrush(trackColor);
            using var focusPen = new Pen(Focused ? Accent : Color.Transparent);
            pevent.Graphics.FillPath(trackBrush, trackPath);
            if (Focused) pevent.Graphics.DrawPath(focusPen, trackPath);

            var knobSize = track.Height - 6;
            var knobX = active ? track.Right - knobSize - 3 : track.Left + 3;
            var knob = new Rectangle(knobX, track.Top + 3, knobSize, knobSize);
            using var knobBrush = new SolidBrush(Color.White);
            pevent.Graphics.FillEllipse(knobBrush, knob);
        }
    }

    private sealed class NumberField : Control
    {
        private int value;
        private int hoverStep;

        public event EventHandler? ValueChanged;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public int Minimum { get; set; }

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public int Maximum { get; set; } = 100;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public int Increment { get; set; } = 1;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public int Value
        {
            get => value;
            set => SetValue(value);
        }

        public NumberField()
        {
            Height = 32;
            Width = 116;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            BackColor = AppBg;
            Cursor = Cursors.IBeam;
            DoubleBuffered = true;
            TabStop = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.UserPaint, true);
        }

        private void SetValue(int next)
        {
            var clamped = Math.Clamp(next, Minimum, Maximum);
            if (value == clamped) return;
            value = clamped;
            Invalidate();
            ValueChanged?.Invoke(this, EventArgs.Empty);
        }

        private void Step(int direction)
        {
            if (!Enabled) return;
            SetValue(value + direction * Math.Max(1, Increment));
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            var previous = hoverStep;
            hoverStep = StepArea(e.Location);
            Cursor = hoverStep == 0 ? Cursors.IBeam : Cursors.Hand;
            if (previous != hoverStep) Invalidate();
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hoverStep = 0;
            Cursor = Cursors.IBeam;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            var step = StepArea(e.Location);
            if (step != 0) Step(step);
            base.OnMouseDown(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            Step(e.Delta > 0 ? 1 : -1);
            base.OnMouseWheel(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Up)
            {
                e.Handled = true;
                Step(1);
            }
            else if (e.KeyCode == Keys.Down)
            {
                e.Handled = true;
                Step(-1);
            }

            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(PaintBackColor(this));

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            var borderColor = Focused ? Accent : Border;
            var fillColor = Enabled ? Surface : Color.FromArgb(234, 239, 246);
            using var path = RoundedRect(rect, 7);
            using var fill = new SolidBrush(fillColor);
            using var border = new Pen(borderColor, Focused ? 1.5f : 1f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            var textRect = new Rectangle(10, 0, Width - 42, Height);
            var valueColor = Enabled ? TextStrong : TextMuted;
            TextRenderer.DrawText(e.Graphics, value.ToString(), Font, textRect, valueColor, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

            var dividerX = Width - 30;
            using var divider = new Pen(BorderSoft);
            e.Graphics.DrawLine(divider, dividerX, 5, dividerX, Height - 6);

            DrawStepper(e.Graphics, new Rectangle(Width - 29, 1, 28, (Height - 2) / 2), 1);
            DrawStepper(e.Graphics, new Rectangle(Width - 29, Height / 2, 28, (Height - 2) / 2), -1);
        }

        private int StepArea(Point point)
        {
            if (point.X < Width - 30 || point.X > Width || point.Y < 0 || point.Y > Height) return 0;
            return point.Y < Height / 2 ? 1 : -1;
        }

        private void DrawStepper(Graphics graphics, Rectangle area, int direction)
        {
            var active = Enabled && hoverStep == direction;
            var arrowColor = Enabled ? (active ? Accent : TextMuted) : Color.FromArgb(158, 169, 182);
            if (active)
            {
                using var hover = new SolidBrush(Color.FromArgb(236, 247, 244));
                graphics.FillRectangle(hover, area);
            }

            var centerX = area.Left + area.Width / 2;
            var centerY = area.Top + area.Height / 2;
            var points = direction > 0
                ? new[] { new Point(centerX - 4, centerY + 2), new Point(centerX, centerY - 3), new Point(centerX + 4, centerY + 2) }
                : new[] { new Point(centerX - 4, centerY - 2), new Point(centerX, centerY + 3), new Point(centerX + 4, centerY - 2) };

            using var brush = new SolidBrush(arrowColor);
            graphics.FillPolygon(brush, points);
        }
    }

    private sealed class TerminalLogView : Control
    {
        private readonly List<string> lines = [];
        private int firstLine;
        private bool draggingScrollbar;
        private bool hoveringScrollbar;
        private int dragStartY;
        private int dragStartFirstLine;
        private string logText = "";

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public string LogText
        {
            get => logText;
            set
            {
                if (logText == value) return;
                logText = value ?? "";
                lines.Clear();
                lines.AddRange(logText.Replace("\r", "").Split('\n'));
                if (lines.Count > 0 && lines[^1].Length == 0) lines.RemoveAt(lines.Count - 1);
                ScrollToBottom();
                Invalidate();
            }
        }

        public TerminalLogView()
        {
            Font = new Font("Cascadia Mono", 9.25f);
            BackColor = AppBg;
            ForeColor = TerminalText;
            DoubleBuffered = true;
            TabStop = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.UserPaint, true);
        }

        protected override void OnResize(EventArgs e)
        {
            ClampScroll();
            base.OnResize(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            ScrollLines(e.Delta > 0 ? -3 : 3);
            base.OnMouseWheel(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            if (TryGetScrollbar(out var track, out var thumb) && track.Contains(e.Location))
            {
                if (thumb.Contains(e.Location))
                {
                    draggingScrollbar = true;
                    dragStartY = e.Y;
                    dragStartFirstLine = firstLine;
                    Capture = true;
                }
                else
                {
                    ScrollLines(e.Y < thumb.Top ? -VisibleLineCount() : VisibleLineCount());
                }
            }

            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (draggingScrollbar)
            {
                if (TryGetScrollbar(out var track, out var thumb))
                {
                    var maxFirst = MaxFirstLine();
                    var travel = Math.Max(1, track.Height - thumb.Height);
                    var deltaLines = (int)Math.Round((double)(e.Y - dragStartY) / travel * maxFirst);
                    firstLine = Math.Clamp(dragStartFirstLine + deltaLines, 0, maxFirst);
                    Invalidate();
                }
            }
            else
            {
                var wasHovering = hoveringScrollbar;
                hoveringScrollbar = TryGetScrollbar(out _, out var thumb) && thumb.Contains(e.Location);
                if (wasHovering != hoveringScrollbar) Invalidate();
            }

            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hoveringScrollbar = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            draggingScrollbar = false;
            Capture = false;
            base.OnMouseUp(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            switch (e.KeyCode)
            {
                case Keys.Up:
                    e.Handled = true;
                    ScrollLines(-1);
                    break;
                case Keys.Down:
                    e.Handled = true;
                    ScrollLines(1);
                    break;
                case Keys.PageUp:
                    e.Handled = true;
                    ScrollLines(-VisibleLineCount());
                    break;
                case Keys.PageDown:
                    e.Handled = true;
                    ScrollLines(VisibleLineCount());
                    break;
                case Keys.Home:
                    e.Handled = true;
                    firstLine = 0;
                    Invalidate();
                    break;
                case Keys.End:
                    e.Handled = true;
                    ScrollToBottom();
                    Invalidate();
                    break;
            }

            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(PaintBackColor(this));

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using var path = RoundedRect(rect, 9);
            using var fill = new SolidBrush(TerminalBg);
            using var border = new Pen(Focused ? Accent : TerminalBg, Focused ? 1.4f : 1f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            var padding = new Padding(14, 12, 22, 12);
            var content = new Rectangle(padding.Left, padding.Top, Width - padding.Left - padding.Right, Height - padding.Top - padding.Bottom);
            if (content.Width <= 0 || content.Height <= 0) return;

            using var region = new Region(content);
            var previousClip = e.Graphics.Clip;
            e.Graphics.SetClip(region, CombineMode.Replace);

            var lineHeight = LineHeight();
            var visible = VisibleLineCount();
            var count = lines.Count == 0 ? 1 : lines.Count;
            for (var i = 0; i < visible && firstLine + i < count; i++)
            {
                var text = lines.Count == 0 ? "" : lines[firstLine + i];
                var lineRect = new Rectangle(content.Left, content.Top + i * lineHeight, content.Width, lineHeight);
                TextRenderer.DrawText(e.Graphics, text, Font, lineRect, TerminalText, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
            }

            e.Graphics.Clip = previousClip;

            if (TryGetScrollbar(out var track, out var thumb))
            {
                using var trackBrush = new SolidBrush(Color.FromArgb(35, 48, 61));
                using var thumbBrush = new SolidBrush(hoveringScrollbar || draggingScrollbar ? Color.FromArgb(126, 143, 160) : Color.FromArgb(86, 101, 119));
                using var trackPath = RoundedRect(track, 4);
                using var thumbPath = RoundedRect(thumb, 4);
                e.Graphics.FillPath(trackBrush, trackPath);
                e.Graphics.FillPath(thumbBrush, thumbPath);
            }
        }

        private int LineHeight() => Font.Height + 3;

        private int VisibleLineCount()
        {
            var height = Math.Max(0, Height - 24);
            return Math.Max(1, height / LineHeight());
        }

        private int MaxFirstLine() => Math.Max(0, lines.Count - VisibleLineCount());

        private void ClampScroll()
        {
            firstLine = Math.Clamp(firstLine, 0, MaxFirstLine());
        }

        private void ScrollLines(int delta)
        {
            firstLine = Math.Clamp(firstLine + delta, 0, MaxFirstLine());
            Invalidate();
        }

        private void ScrollToBottom()
        {
            firstLine = MaxFirstLine();
        }

        private bool TryGetScrollbar(out Rectangle track, out Rectangle thumb)
        {
            track = Rectangle.Empty;
            thumb = Rectangle.Empty;
            var visible = VisibleLineCount();
            if (lines.Count <= visible) return false;

            track = new Rectangle(Width - 13, 13, 5, Math.Max(1, Height - 26));
            var maxFirst = MaxFirstLine();
            var thumbHeight = Math.Max(28, (int)Math.Round((double)visible / lines.Count * track.Height));
            var travel = Math.Max(1, track.Height - thumbHeight);
            var thumbTop = track.Top + (maxFirst == 0 ? 0 : (int)Math.Round((double)firstLine / maxFirst * travel));
            thumb = new Rectangle(track.Left, thumbTop, track.Width, thumbHeight);
            return true;
        }
    }

    private sealed class RouteCard : Control
    {
        private bool hovering;
        private bool selected;

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public string RouteId { get; set; } = "";

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public string Title { get; set; } = "";

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public string Address { get; set; } = "";

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public string Description { get; set; } = "";

        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public bool Selected
        {
            get => selected;
            set
            {
                selected = value;
                Invalidate();
            }
        }

        public RouteCard()
        {
            Dock = DockStyle.Fill;
            BackColor = AppBg;
            Cursor = Cursors.Hand;
            DoubleBuffered = true;
            TabStop = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.UserPaint, true);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovering = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (Enabled && (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter))
            {
                e.Handled = true;
                OnClick(EventArgs.Empty);
            }

            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(PaintBackColor(this));
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            var borderColor = Selected ? Accent : Focused ? Accent : hovering ? Color.FromArgb(174, 196, 216) : BorderSoft;
            var fillColor = Enabled ? (Selected ? AccentSoft : Surface) : SurfaceAlt;
            using var path = RoundedRect(rect, 9);
            using var fill = new SolidBrush(fillColor);
            using var border = new Pen(borderColor, Selected ? 2f : 1f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            var textColor = Enabled ? TextStrong : TextMuted;
            using var titleFont = new Font("Segoe UI", 13.5f, FontStyle.Bold);
            using var addressFont = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            using var bodyFont = new Font("Segoe UI", 9f);
            var addressColor = Enabled ? Accent : TextMuted;
            TextRenderer.DrawText(e.Graphics, Title, titleFont, new Rectangle(16, 14, Width - 56, 26), textColor, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(e.Graphics, Address, addressFont, new Rectangle(16, 43, Width - 32, 22), addressColor, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(e.Graphics, Description, bodyFont, new Rectangle(16, 68, Width - 32, Height - 80), TextMuted, TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.EndEllipsis);

            var checkRect = new Rectangle(Width - 36, 17, 18, 18);
            using var checkPath = RoundedRect(checkRect, 9);
            using var checkFill = new SolidBrush(Selected ? Accent : Surface);
            using var checkBorder = new Pen(Selected ? Accent : Border);
            e.Graphics.FillPath(checkFill, checkPath);
            e.Graphics.DrawPath(checkBorder, checkPath);
            if (Selected)
            {
                using var checkPen = new Pen(Color.White, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
                e.Graphics.DrawLines(checkPen, new[]
                {
                    new Point(checkRect.Left + 5, checkRect.Top + 9),
                    new Point(checkRect.Left + 8, checkRect.Top + 12),
                    new Point(checkRect.Left + 13, checkRect.Top + 6)
                });
            }
        }
    }

    private sealed class StatusBadge : Control
    {
        private string label = "Checking";
        private bool healthy;

        public StatusBadge()
        {
            DoubleBuffered = true;
            Height = 44;
        }

        public void SetState(string text, bool isHealthy)
        {
            label = text;
            healthy = isHealthy;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var dotColor = healthy ? Accent : Danger;
            using var path = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), Height / 2);
            using var fill = new SolidBrush(Surface);
            using var border = new Pen(Border);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            using var font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            var textSize = TextRenderer.MeasureText(e.Graphics, label, font, Size.Empty, TextFormatFlags.NoPadding);
            const int dotSize = 10;
            const int gap = 8;
            var groupWidth = dotSize + gap + textSize.Width;
            var startX = Math.Max(12, (Width - groupWidth) / 2);
            var dotY = (Height - dotSize) / 2;
            var textRect = new Rectangle(startX + dotSize + gap, 0, textSize.Width + 1, Height);

            using var dot = new SolidBrush(dotColor);
            e.Graphics.FillEllipse(dot, startX, dotY, dotSize, dotSize);
            TextRenderer.DrawText(e.Graphics, label, font, textRect, TextStrong, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
        }
    }

    private sealed class LogoMark : Control
    {
        private static readonly Image? LogoImage = LoadLogoImage();
        private static readonly Rectangle LogoSourceRect = new(92, 54, 836, 900);

        public LogoMark()
        {
            DoubleBuffered = true;
            BackColor = AppBg;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(PaintBackColor(this));

            if (LogoImage is null)
            {
                using var fallbackFont = new Font("Segoe UI", 14f, FontStyle.Bold);
                TextRenderer.DrawText(e.Graphics, "HP", fallbackFont, ClientRectangle, Accent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                return;
            }

            e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;

            var source = Rectangle.Intersect(LogoSourceRect, new Rectangle(0, 0, LogoImage.Width, LogoImage.Height));
            if (source.Width <= 0 || source.Height <= 0) source = new Rectangle(0, 0, LogoImage.Width, LogoImage.Height);

            var available = new Rectangle(0, 0, Math.Max(1, Width - 2), Math.Max(1, Height - 2));
            var scale = Math.Min(available.Width / (double)source.Width, available.Height / (double)source.Height);
            var drawWidth = Math.Max(1, (int)Math.Round(source.Width * scale));
            var drawHeight = Math.Max(1, (int)Math.Round(source.Height * scale));
            var target = new Rectangle(
                available.Left + (available.Width - drawWidth) / 2,
                available.Top + Math.Max(0, (available.Height - drawHeight) / 2 - 6),
                drawWidth,
                drawHeight);

            e.Graphics.DrawImage(LogoImage, target, source, GraphicsUnit.Pixel);
        }

        private static Image? LoadLogoImage()
        {
            using var stream = typeof(MainForm).Assembly.GetManifestResourceStream("HypixelProxy.App.Assets.HypixelProxyLogo.png");
            if (stream is null) return null;

            using var image = Image.FromStream(stream);
            return new Bitmap(image);
        }
    }

    private static GraphicsPath RoundedRect(Rectangle rect, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        if (diameter <= 0)
        {
            path.AddRectangle(rect);
            return path;
        }

        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
