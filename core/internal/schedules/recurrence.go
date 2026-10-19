package schedules

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

const MaxTime int64 = 8640000000000000

var ErrInvalid = errors.New("schedule_invalid")
var ErrConflict = errors.New("schedule_conflict")
var ErrNotFound = errors.New("schedule_not_found")
var ErrUnavailable = errors.New("schedule_unavailable")

type cronField struct {
	values   []int
	wildcard bool
}

type Cron struct {
	Expression                              string
	minutes, hours, dates, months, weekdays cronField
}

var monthNames = map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
var weekdayNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

func parseField(source string, min, max int, names map[string]int) (cronField, error) {
	values := map[int]bool{}
	number := func(raw string) (int, error) {
		if value, ok := names[raw]; ok {
			return value, nil
		}
		if raw == "" || len(raw) > 2 {
			return 0, ErrInvalid
		}
		for _, digit := range raw {
			if digit < '0' || digit > '9' {
				return 0, ErrInvalid
			}
		}
		value, err := strconv.Atoi(raw)
		if err != nil || value < min || value > max {
			return 0, ErrInvalid
		}
		return value, nil
	}
	for _, part := range strings.Split(source, ",") {
		pieces := strings.Split(part, "/")
		if len(pieces) > 2 || pieces[0] == "" {
			return cronField{}, ErrInvalid
		}
		step := 1
		var err error
		if len(pieces) == 2 {
			if len(pieces[1]) > 2 || pieces[1] == "" {
				return cronField{}, ErrInvalid
			}
			for _, digit := range pieces[1] {
				if digit < '0' || digit > '9' {
					return cronField{}, ErrInvalid
				}
			}
			step, err = strconv.Atoi(pieces[1])
			if err != nil || step < 1 || step > max-min+1 {
				return cronField{}, ErrInvalid
			}
		}
		first, last := min, max
		if pieces[0] != "*" {
			ends := strings.Split(pieces[0], "-")
			if len(ends) == 1 {
				if len(pieces) > 1 {
					return cronField{}, ErrInvalid
				}
				first, err = number(ends[0])
				last = first
			} else if len(ends) == 2 {
				first, err = number(ends[0])
				if err == nil {
					last, err = number(ends[1])
				}
			} else {
				return cronField{}, ErrInvalid
			}
			if err != nil || first > last {
				return cronField{}, ErrInvalid
			}
		}
		for value := first; value <= last; value += step {
			values[value] = true
		}
	}
	result := cronField{wildcard: strings.Contains(source, "*")}
	for value := range values {
		result.values = append(result.values, value)
	}
	sort.Ints(result.values)
	return result, nil
}

func ParseCron(value string) (Cron, error) {
	if len(value) > 256 || strings.ContainsAny(value, "\r\n\x00") {
		return Cron{}, ErrInvalid
	}
	expression := strings.ToLower(strings.Join(strings.FieldsFunc(value, func(character rune) bool { return contracts.TrimText(string(character)) == "" }), " "))
	parts := strings.Split(expression, " ")
	if len(parts) != 5 {
		return Cron{}, ErrInvalid
	}
	mins := []int{0, 0, 1, 1, 0}
	maxs := []int{59, 23, 31, 12, 7}
	fields := make([]cronField, 5)
	for index, part := range parts {
		var names map[string]int
		if index == 3 {
			names = monthNames
		}
		if index == 4 {
			names = weekdayNames
		}
		field, err := parseField(part, mins[index], maxs[index], names)
		if err != nil {
			return Cron{}, err
		}
		fields[index] = field
	}
	weekdays := map[int]bool{}
	for _, value := range fields[4].values {
		weekdays[value%7] = true
	}
	fields[4].values = nil
	for value := range weekdays {
		fields[4].values = append(fields[4].values, value)
	}
	sort.Ints(fields[4].values)
	return Cron{expression, fields[0], fields[1], fields[2], fields[3], fields[4]}, nil
}

func TimeZone(name string) (*time.Location, error) {
	canonical, ok := i18n.CanonicalTimeZone(name)
	if !ok {
		return nil, ErrInvalid
	}
	location, err := time.LoadLocation(canonical)
	if err != nil {
		return nil, ErrInvalid
	}
	return location, nil
}

func includes(values []int, value int) bool {
	index := sort.SearchInts(values, value)
	return index < len(values) && values[index] == value
}

// NextAt evaluates real instants, preserving both occurrences of a repeated DST minute.
func NextAt(expression string, after int64, zone string) (int64, error) {
	cron, err := ParseCron(expression)
	if err != nil || after <= 0 || after >= MaxTime {
		return 0, ErrInvalid
	}
	location, err := TimeZone(zone)
	if err != nil {
		return 0, err
	}
	current := time.UnixMilli(after).In(location)
	first := time.Date(current.Year(), current.Month(), current.Day(), 0, 0, 0, 0, time.UTC)
	for index := 0; index <= 366*8+2; index++ {
		date := first.AddDate(0, 0, index)
		if !includes(cron.months.values, int(date.Month())) {
			continue
		}
		dateMatch := includes(cron.dates.values, date.Day())
		weekdayMatch := includes(cron.weekdays.values, int(date.Weekday()))
		match := dateMatch || weekdayMatch
		if cron.dates.wildcard || cron.weekdays.wildcard {
			match = dateMatch && weekdayMatch
		}
		if !match {
			continue
		}
		offsets := map[int]bool{}
		for _, hours := range []int{-24, 0, 12, 24, 48} {
			sample := date.Add(time.Duration(hours) * time.Hour)
			if sample.UnixMilli() <= 0 || sample.UnixMilli() > MaxTime {
				continue
			}
			_, offset := sample.In(location).Zone()
			offsets[offset] = true
		}
		earliest := int64(0)
		for offset := range offsets {
		search:
			for _, hour := range cron.hours.values {
				for _, minute := range cron.minutes.values {
					candidate := date.UnixMilli() + int64(hour)*3600000 + int64(minute)*60000 - int64(offset)*1000
					if candidate <= after || candidate <= 0 || candidate > MaxTime {
						continue
					}
					if earliest > 0 && candidate >= earliest {
						break search
					}
					parts := time.UnixMilli(candidate).In(location)
					if parts.Year() == date.Year() && parts.Month() == date.Month() && parts.Day() == date.Day() && parts.Hour() == hour && parts.Minute() == minute {
						earliest = candidate
						break search
					}
				}
			}
		}
		if earliest > 0 {
			return earliest, nil
		}
	}
	return 0, ErrInvalid
}
