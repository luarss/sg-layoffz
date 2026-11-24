interface ChartDataTableProps {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}

function formatCell(value: string | number): string {
  return typeof value === 'number' ? value.toLocaleString() : value;
}

export default function ChartDataTable({ caption, columns, rows }: ChartDataTableProps) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, index) => (
              <td key={columns[index]}>{formatCell(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
