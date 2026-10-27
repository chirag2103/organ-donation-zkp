"""Render completed raw measurements into manuscript tables and standalone figures."""
from pathlib import Path
import json

root = Path(__file__).resolve().parent.parent
folder = root / 'paper' / 'evaluation-v2'
data = json.loads((folder / 'benchmark-v2.json').read_text(encoding='utf-8'))
if not data['meta'].get('complete'):
    raise RuntimeError('Refusing to publish an incomplete benchmark')
if data['meta'].get('profile') != 'research' or data['meta']['samples'] != 30 or data['meta']['warmups'] != 10:
    raise RuntimeError('Refusing to publish smoke runs or unexpected sample counts')

labels = {
    'enrollment': 'Approved-root enrollment',
    'membershipPath': 'Membership witness construction',
    'proofGeneration': 'Node Groth16 proving',
    'verifyTransactionLocal': 'Local authorization receipt',
    'bfvEncrypt': 'BFV record encryption',
    'bfvEvaluate': 'BFV policy evaluation',
    'bfvRelease': 'Permitted-result release',
    'encryptedStorageRoundTrip': 'Encrypted storage round trip',
    'revocationRequestLocal': 'Local revocation request receipt',
    'revocationExecutionLocal': 'Local deactivation receipt',
    'localCleanup': 'Direct local cleanup',
}
lines = [r'\paragraph{Measured local results.} Ten warmups and thirty measured samples were used for every repeated timing metric below. The table reports milliseconds; Node proving includes path construction and is not a browser latency measurement. Local receipt times exclude real-network consensus; direct cleanup excludes worker discovery and retry delay.',
         r'\begin{center}\begin{tabular}{lrrr}\toprule Metric & Median (ms) & p95 (ms) & SD (ms)\\\midrule']
for key, label in labels.items():
    value = data['timings'][key]
    lines.append(f"{label} & {value['median']:.2f} & {value['p95']:.2f} & {value['std']:.2f}" + r'\\')
lines += [r'\bottomrule\end{tabular}\end{center}',
          r'\paragraph{Verification gas.} Median real Groth16 verification plus authorization issuance: '
          + f"{data['gas']['verifyAndIssue']['median']:,.0f}" + ' gas (30 measured samples after ten warmups). Initial issuance, recorded separately: '
          + f"{data['gas']['initialVerificationIssuance']:,.0f}" + ' gas; warmed samples reuse the same wallet session slot.',
          r'\paragraph{Workload interpretation.} The plaintext baseline uses memory-resident synthetic data, while BFV uses real encrypted Kubo records. Differences include storage and protection costs; they do not isolate proof cost. Jobs use an established session, with proving and authorization measured separately rather than repeated per job. Job timings include 100-ms result polling, which affects small-workload latency. Raw samples and source/artifact identifiers accompany the evaluation.']
matrix_labels = {'plaintextWalletRbac': 'Plaintext wallet RBAC', 'bfvWalletRbac': 'BFV wallet RBAC', 'bfvZkpAuthorization': 'BFV ZKP authorization'}
lines += [r'\begin{center}\begin{tabular}{llrrr}\toprule Baseline & Matrix & Median (ms) & p95 (ms) & SD (ms)\\\midrule']
for baseline, workloads in data['workloads'].items():
    for size, value in workloads.items():
        lines.append(f"{matrix_labels[baseline]} & {size} & {value['median']:.2f} & {value['p95']:.2f} & {value['std']:.2f}" + r'\\')
lines += [r'\bottomrule\end{tabular}\end{center}']
(root / 'paper' / 'results-v2.tex').write_text('\n'.join(lines) + '\n', encoding='utf-8')
p = data['timings']['proofGeneration']['median']
e = data['timings']['bfvEvaluate']['median']
gas = data['gas']['verifyAndIssue']['median']
(root / 'paper' / 'results-slides-v2.tex').write_text(
    r'\small Measured local medians: Node proving ' + f'{p:.1f}' + ' ms; BFV evaluation '
    + f'{e:.1f}' + ' ms; verification and authorization ' + f'{gas:,.0f}' + ' gas.\n', encoding='utf-8')

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except ImportError:
    # ReportLab is a standard chart/PDF toolkit and is available in this environment.
    # Use its logarithmic chart axes rather than drawing an illustrative curve.
    import math
    import reportlab
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.graphics.charts.axes import LogXValueAxis, LogYValueAxis
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.widgets.markers import makeMarker
    from reportlab.graphics import renderPDF, renderSVG
    from reportlab.lib import colors

    drawing = Drawing(640, 400)
    chart = LinePlot()
    chart.x, chart.y, chart.width, chart.height = 70, 65, 530, 235
    chart.xValueAxis = LogXValueAxis()
    chart.yValueAxis = LogYValueAxis()
    chart.xValueAxis.valueMin, chart.xValueAxis.valueMax = 1, 100
    chart.xValueAxis.valueSteps = [1, 25, 100]
    chart.xValueAxis.labelTextFormat = lambda value: {1: '1 (1x1)', 25: '25 (5x5)', 100: '100 (10x10)'}.get(value, str(value))
    palette = [colors.HexColor('#1764ab'), colors.HexColor('#c44e18'), colors.HexColor('#278148')]
    values = []
    pairs = [1, 25, 100]
    sizes = ['1x1', '5x5', '10x10']
    for baseline in matrix_labels:
        workloads = data['workloads'][baseline]
        values.append(list(zip(pairs, [workloads[size]['median'] for size in sizes])))
    for baseline in matrix_labels:
        workloads = data['workloads'][baseline]
        values.append(list(zip(pairs, [workloads[size]['p95'] for size in sizes])))
    chart.data = values
    low = min(v for series in values for _, v in series)
    high = max(v for series in values for _, v in series)
    chart.yValueAxis.valueMin = 10 ** math.floor(math.log10(low * .9))
    chart.yValueAxis.valueMax = 10 ** math.ceil(math.log10(high * 1.1))
    chart.yValueAxis.visibleGrid = True
    chart.yValueAxis.gridStrokeColor = colors.HexColor('#dddddd')
    chart.yValueAxis.labelTextFormat = lambda value: f'{value:g}'
    for i, color in enumerate(palette):
        chart.lines[i].strokeColor = color
        chart.lines[i].strokeWidth = 1.6
        marker = makeMarker('FilledCircle')
        marker.size, marker.fillColor, marker.strokeColor = 5, color, color
        chart.lines[i].symbol = marker
        chart.lines[i + 3].strokeColor = None
        tick = makeMarker('Cross')
        tick.size, tick.strokeColor = 6, color
        tick.strokeWidth = 1
        chart.lines[i + 3].symbol = tick
    drawing.add(chart)
    drawing.add(String(320, 380, 'Synthetic local matching jobs', textAnchor='middle', fontName='Helvetica-Bold', fontSize=15))
    drawing.add(String(320, 360, 'Median: connected circles; p95: crosses. Logarithmic axes.', textAnchor='middle', fontSize=10))
    drawing.add(String(320, 24, 'Pairs per authenticated HTTP job', textAnchor='middle', fontSize=11))
    drawing.add(String(12, 190, 'Latency (ms)', fontSize=10))
    legend = Legend()
    legend.x, legend.y, legend.fontSize, legend.deltay = 85, 346, 9, 13
    legend.colorNamePairs = list(zip(palette, matrix_labels.values()))
    drawing.add(legend)
    renderPDF.drawToFile(drawing, str(folder / 'workload-latency.pdf'))
    renderSVG.drawToFile(drawing, str(folder / 'workload-latency.svg'))
    (folder / 'plotting-requirements.txt').write_text(f'reportlab=={reportlab.Version}\n', encoding='utf-8')
    print('Rendered manuscript tables and ReportLab PDF/SVG workload figures.')
else:
    fig, ax = plt.subplots(figsize=(7.4, 4.4), layout='constrained')
    for baseline, label in matrix_labels.items():
        values = data['workloads'][baseline]
        medians = [values[size]['median'] for size in ['1x1', '5x5', '10x10']]
        p95s = [values[size]['p95'] for size in ['1x1', '5x5', '10x10']]
        ax.plot([1, 25, 100], medians, marker='o', label=label)
        ax.scatter([1, 25, 100], p95s, marker='+', s=70)
    ax.set(xscale='log', yscale='log', xlabel='Pairs per authenticated HTTP job', ylabel='Latency (ms, log scale)',
           title='Synthetic local matching: median (lines) and p95 (crosses)')
    ax.set_xticks([1, 25, 100], ['1 (1x1)', '25 (5x5)', '100 (10x10)'])
    ax.grid(alpha=.25);ax.legend(fontsize=9)
    for suffix in ['png', 'pdf', 'svg']:
        fig.savefig(folder / ('workload-latency.' + suffix), dpi=200)
    plt.close(fig)
    (folder / 'plotting-requirements.txt').write_text(f'matplotlib=={matplotlib.__version__}\n', encoding='utf-8')
    print('Rendered manuscript tables and standalone workload figures.')
